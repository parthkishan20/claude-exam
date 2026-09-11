/**
 * SSE chat endpoint — model deltas + trace events, one TraceEvent per frame.
 *
 * WAVE 1 — AGENT C owns this file.
 *
 * REQUEST SHAPE (chosen: full-history, with a convenience tail)
 * ------------------------------------------------------------
 *   POST /api/chat
 *   { "sessionId": string,
 *     "messages":  Anthropic.MessageParam[],   // the ENTIRE conversation so far
 *     "userMessage"?: string }                 // optional; appended as a user turn
 *
 * `messages` is canonical: the Messages API is stateless, so the client owns the
 * transcript and resends it every turn. `userMessage` exists only so a caller
 * that keeps history separately can post the new turn without splicing it in
 * itself; when both are present the string is appended AFTER `messages`. At
 * least one of the two must be provided.
 *
 * `sessionId` selects the in-memory tool store (lib/store/db.ts) — it is the
 * side-effect namespace, NOT a conversation store. Two tabs with the same
 * sessionId share orders, refunds and escalations.
 *
 * RESPONSE: text/event-stream. Every frame is `data: ${JSON.stringify(ev)}\n\n`
 * where `ev` is a lib/types.ts TraceEvent. The stream always terminates with a
 * `{"t":"done"}` frame — including on failure, which is reported as a
 * `{"t":"error"}` frame first rather than by dropping the connection.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  credentialsAvailable,
  describeError,
  MISSING_CREDENTIALS_MESSAGE,
  runAgent,
} from "@/lib/loop";
import type { TraceEvent } from "@/lib/types";

// The Anthropic SDK needs Node, not Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  sessionId?: unknown;
  messages?: unknown;
  userMessage?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const body: ChatRequestBody = await req.json().catch(() => ({}) as ChatRequestBody);
  const parsed = parseBody(body);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (ev: TraceEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // Client went away mid-write; stop trying to push frames.
          open = false;
        }
      };

      try {
        if ("error" in parsed) {
          emit({ t: "error", message: parsed.error });
        } else if (!(await credentialsAvailable())) {
          emit({ t: "error", message: MISSING_CREDENTIALS_MESSAGE });
        } else {
          await runAgent({
            sessionId: parsed.sessionId,
            messages: parsed.messages,
            emit,
            signal: req.signal,
          });
        }
      } catch (err) {
        emit({ t: "error", message: describeError(err) });
      } finally {
        emit({ t: "done" });
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables proxy buffering (nginx and friends) so frames arrive live.
      "X-Accel-Buffering": "no",
    },
  });
}

type ParsedBody =
  | { sessionId: string; messages: Anthropic.MessageParam[] }
  | { error: string };

function parseBody(body: ChatRequestBody): ParsedBody {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) return { error: "Request body must include a non-empty string `sessionId`." };

  const messages: Anthropic.MessageParam[] = [];
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) {
      return { error: "`messages` must be an array of Anthropic MessageParam objects." };
    }
    for (const m of body.messages) {
      if (!isMessageParam(m)) {
        return {
          error: "Every entry in `messages` must be { role: 'user' | 'assistant', content }.",
        };
      }
      messages.push(m);
    }
  }

  if (typeof body.userMessage === "string" && body.userMessage.trim()) {
    messages.push({ role: "user", content: body.userMessage });
  }

  if (messages.length === 0) {
    return { error: "Provide `messages` (full history) and/or a non-empty `userMessage`." };
  }
  if (messages[0].role !== "user") {
    return { error: "The first message must have role 'user'." };
  }
  return { sessionId, messages };
}

function isMessageParam(v: unknown): v is Anthropic.MessageParam {
  if (typeof v !== "object" || v === null) return false;
  const m = v as { role?: unknown; content?: unknown };
  if (m.role !== "user" && m.role !== "assistant") return false;
  return typeof m.content === "string" || Array.isArray(m.content);
}
