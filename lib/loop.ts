/**
 * The manual streaming agentic loop.
 *
 * WAVE 1 — AGENT C owns this file.
 *
 * Non-negotiable rules:
 *  - append the FULL `message.content` to messages (preserves tool_use blocks)
 *  - return ALL tool_result blocks in ONE user message (splitting them trains
 *    the model out of parallel tool calls)
 *  - set `is_error: true` on every failure envelope
 *  - handle stop_reason "pause_turn" by re-sending
 *  - break at LIMITS.maxLoopIterations
 *  - route every tool_use through dispatch() — never call a handler directly
 */
import Anthropic from "@anthropic-ai/sdk";
import { LIMITS, MAX_TOKENS, MODEL } from "./config";
import { dispatch } from "./dispatch";
import { transientError } from "./errors";
import { SYSTEM_PROMPT } from "./systemPrompt";
import { TOOL_SCHEMAS } from "./tools/schemas";
import { isFailure } from "./types";
import type { Emit, ToolName, ToolResultEnvelope, TraceEvent } from "./types";

export interface RunAgentOptions {
  sessionId: string;
  messages: Anthropic.MessageParam[];
  emit: Emit;
  signal?: AbortSignal;
}

export interface RunAgentResult {
  messages: Anthropic.MessageParam[];
  finalText: string;
  turns: number;
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

let cachedClient: Anthropic | null = null;

/**
 * Zero-arg construction on purpose: the SDK resolves ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile on disk. Passing an
 * explicit apiKey would defeat the profile path. Construction never throws —
 * credential resolution failures surface on the first request, which is why
 * `credentialsAvailable()` exists as a pre-flight for a friendlier message.
 */
function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

export const MISSING_CREDENTIALS_MESSAGE =
  "No Anthropic credentials found. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) " +
  "in the environment, or run `ant auth login` to store a credential profile, then " +
  "restart the dev server.";

/**
 * Mirrors the SDK's credential-source lookup closely enough to fail fast with a
 * readable message. A false positive here is harmless — the real request still
 * validates and `describeError` maps its failure.
 */
export async function credentialsAvailable(): Promise<boolean> {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) {
    return true;
  }
  // Workload identity federation.
  if (env.ANTHROPIC_FEDERATION_RULE_ID && env.ANTHROPIC_ORGANIZATION_ID) return true;

  const root =
    env.ANTHROPIC_CONFIG_DIR ??
    (env.XDG_CONFIG_HOME ? `${env.XDG_CONFIG_HOME}/anthropic` : undefined) ??
    (env.HOME ? `${env.HOME}/.config/anthropic` : undefined) ??
    (env.APPDATA ? `${env.APPDATA}/Anthropic` : undefined);
  if (!root) return false;

  try {
    const fs = await import("node:fs/promises");
    await fs.access(root);
    return true;
  } catch {
    return false;
  }
}

/** Turns any thrown value into something worth putting in a `TraceEvent`. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return `${MISSING_CREDENTIALS_MESSAGE} (the API rejected the current credentials: ${err.message})`;
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status === undefined ? "" : ` ${err.status}`;
    return `Anthropic API error${status}: ${err.message}`;
  }
  if (err instanceof Error) {
    if (/could not resolve authentication method/i.test(err.message)) {
      return MISSING_CREDENTIALS_MESSAGE;
    }
    return err.message;
  }
  return String(err);
}

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { sessionId, emit, signal } = opts;
  const messages: Anthropic.MessageParam[] = [...opts.messages];
  let finalText = "";
  let turns = 0;
  let hitCap = true;

  for (let turn = 1; turn <= LIMITS.maxLoopIterations; turn += 1) {
    if (signal?.aborted) {
      hitCap = false;
      break;
    }
    turns = turn;
    emit({ t: "turn_start", turn });

    /*
     * Request parameters, deliberately minimal:
     *  - thinking adaptive + summarized: `budget_tokens` is rejected on this
     *    model, and without `display` the thinking text comes back empty, which
     *    would leave the trace panel's thinking rows blank.
     *  - no temperature / top_p / top_k: removed on this model, they 400.
     *  - no assistant prefill: 400s.
     *  - streaming is required at MAX_TOKENS = 64000.
     */
    const stream = getClient().messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOL_SCHEMAS,
        thinking: { type: "adaptive", display: "summarized" },
        messages,
      },
      signal ? { signal } : undefined,
    );

    let message: Anthropic.Message;
    let turnText = "";
    try {
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "thinking_delta") {
          emit({ t: "thinking_delta", text: event.delta.thinking });
        } else if (event.delta.type === "text_delta") {
          turnText += event.delta.text;
          emit({ t: "text_delta", text: event.delta.text });
        }
      }
      // finalMessage() owns completion/error/abort — never re-wrap .on() in a Promise.
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
        hitCap = false;
        break;
      }
      throw err;
    }

    emit({
      t: "turn_end",
      stopReason: message.stop_reason,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
      },
    });

    // RULE 3: the FULL content, always. Dropping it loses the tool_use blocks
    // and the next request would reference tool_use_ids the model never sent.
    messages.push({ role: "assistant", content: message.content });
    if (turnText.trim()) finalText = turnText;

    // RULE 2: a paused turn is re-sent as-is; the assistant turn is already
    // pushed above, so just go round again.
    if (message.stop_reason === "pause_turn") continue;

    if (message.stop_reason !== "tool_use") {
      hitCap = false;
      if (message.stop_reason !== "end_turn") {
        emit({
          t: "error",
          message: `Turn ended with stop_reason "${message.stop_reason}".${
            message.stop_reason === "max_tokens"
              ? " The response was truncated."
              : message.stop_reason === "refusal"
                ? ` ${message.stop_details?.explanation ?? "The model declined the request."}`
                : ""
          }`,
        });
      }
      break;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) {
      // stop_reason said tool_use but no blocks arrived — nothing to answer with,
      // and re-sending would loop forever on an identical request.
      hitCap = false;
      emit({ t: "error", message: 'stop_reason was "tool_use" but no tool_use block was present.' });
      break;
    }

    /*
     * RULE 6 + RULE 8: every block goes through dispatch(), concurrently, but
     * with a stable emit order. With >1 block each dispatch writes into its own
     * buffer and the buffers are flushed in content-block order once all have
     * settled, so two runs of the same scenario produce byte-identical traces.
     * A single block streams straight through — buffering would only add latency.
     */
    const parallel = toolUses.length > 1;
    const buffers: TraceEvent[][] = toolUses.map(() => []);
    const envelopes = await Promise.all(
      toolUses.map((block, i) => {
        const localEmit: Emit = parallel ? (ev) => buffers[i].push(ev) : emit;
        return safeDispatch(block, { sessionId, emit: localEmit });
      }),
    );
    if (parallel) {
      for (const buffered of buffers) for (const ev of buffered) emit(ev);
    }

    // RULE 4 + RULE 5: one user message, every result, is_error on failures.
    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((block, i) => {
      const envelope = envelopes[i];
      const result: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(envelope),
      };
      if (isFailure(envelope)) result.is_error = true;
      return result;
    });
    messages.push({ role: "user", content: toolResults });
  }

  if (hitCap) {
    emit({
      t: "error",
      message: `Loop stopped at the ${LIMITS.maxLoopIterations}-iteration cap without reaching end_turn.`,
    });
  }

  return { messages, finalText, turns };
}

/**
 * dispatch() is contractually non-throwing, but a bug there must not take the
 * whole SSE connection down — and, more importantly, must not leave a tool_use
 * block without a matching tool_result (the next request would be rejected).
 *
 * The synthetic tool_result event below is only emitted on the throw path, so
 * it never duplicates the one dispatch() emits for itself.
 */
async function safeDispatch(
  block: Anthropic.ToolUseBlock,
  ctx: { sessionId: string; emit: Emit },
): Promise<ToolResultEnvelope> {
  const startedAt = Date.now();
  try {
    // `block.input` is already a parsed object — never string-match the
    // serialized form; escaping differs across models.
    return await dispatch(
      { id: block.id, name: block.name as ToolName, input: block.input },
      ctx,
    );
  } catch (err) {
    const envelope = transientError(
      `The ${block.name} tool failed unexpectedly: ${describeError(err)}`,
      0,
      { tool_use_id: block.id },
    );
    ctx.emit({
      t: "tool_result",
      toolUseId: block.id,
      ok: false,
      envelope,
      ms: Date.now() - startedAt,
    });
    return envelope;
  }
}
