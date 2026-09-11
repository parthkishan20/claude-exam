"use client";

/**
 * useAgentStream — the client hook that consumes the agent's SSE trace stream.
 *
 * The backend streams one TraceEvent per SSE frame as `data: ${JSON.stringify(ev)}\n\n`
 * (lib/types.ts). This hook POSTs to /api/chat, reads the response body as a
 * stream, splits on the blank-line frame delimiter, strips the `data: ` prefix,
 * JSON.parses each frame into a TraceEvent and pushes it into React state.
 *
 * It behaves identically whether events arrive from the network or from the
 * hand-written mock in components/mockTrace.ts (see `loadMock` / `playTrace`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { mockTrace } from "@/components/mockTrace";
import type { TraceEvent } from "@/lib/types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
}

interface Options {
  sessionId: string;
}

const MOCK_USER_MESSAGE = "I need a $900 refund on ORD-7788, it arrived broken";

/** Parse one `\n\n`-delimited SSE frame and hand the decoded event to `ingest`. */
function parseFrame(frame: string, ingest: (ev: TraceEvent) => void): void {
  const line = frame.trim();
  if (!line) return;
  // Multi-line frames: concatenate every `data:` line, tolerate a bare payload.
  const payload = line
    .split("\n")
    .map((l) => (l.startsWith("data:") ? l.slice(5).trim() : l.trim()))
    .join("");
  if (!payload || payload === "[DONE]") return;
  try {
    ingest(JSON.parse(payload) as TraceEvent);
  } catch {
    /* ignore a malformed / partial frame */
  }
}

export function useAgentStream({ sessionId }: Options) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantText, setAssistantText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const asstRef = useRef("");
  const thinkRef = useRef("");
  const sawTurnEndRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const ingest = useCallback((ev: TraceEvent) => {
    setEvents((prev) => [...prev, ev]);
    switch (ev.t) {
      case "turn_start":
        asstRef.current = "";
        thinkRef.current = "";
        sawTurnEndRef.current = false;
        setAssistantText("");
        setThinkingText("");
        break;
      case "text_delta":
        asstRef.current += ev.text;
        setAssistantText(asstRef.current);
        break;
      case "thinking_delta":
        thinkRef.current += ev.text;
        setThinkingText(thinkRef.current);
        break;
      case "turn_end": {
        sawTurnEndRef.current = true;
        const content = asstRef.current;
        if (content.trim()) {
          const thinking = thinkRef.current.trim() || undefined;
          setMessages((prev) => [...prev, { role: "assistant", content, thinking }]);
        }
        break;
      }
      case "error":
        setError(ev.message);
        break;
    }
  }, []);

  const finish = useCallback(() => {
    // Safety net: flush a trailing assistant message if the stream ended
    // without a turn_end frame.
    if (!sawTurnEndRef.current && asstRef.current.trim()) {
      const content = asstRef.current;
      const thinking = thinkRef.current.trim() || undefined;
      setMessages((prev) => [...prev, { role: "assistant", content, thinking }]);
    }
    asstRef.current = "";
    thinkRef.current = "";
    setAssistantText("");
    setThinkingText("");
    setIsStreaming(false);
    abortRef.current = null;
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || abortRef.current) return;

      setError(null);
      const outgoing: ChatMessage[] = [
        ...messagesRef.current,
        { role: "user", content: trimmed },
      ];
      setMessages(outgoing);
      asstRef.current = "";
      thinkRef.current = "";
      sawTurnEndRef.current = false;
      setAssistantText("");
      setThinkingText("");
      setIsStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // TODO: if app/api/chat/route.ts lands expecting { sessionId, userMessage },
          // switch to that shape. Until it exists we send the full message list.
          body: JSON.stringify({
            sessionId,
            messages: outgoing.map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(
            `/api/chat responded ${res.status}. Start the backend, or use “Load sample trace”.`,
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) parseFrame(frame, ingest);
        }
        if (buf.trim()) parseFrame(buf, ingest);
      } catch (err) {
        if (!ac.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        finish();
      }
    },
    [sessionId, ingest, finish],
  );

  const playTrace = useCallback(
    async (trace: TraceEvent[]) => {
      if (abortRef.current) return;
      const ac = new AbortController();
      abortRef.current = ac;
      setError(null);
      setIsStreaming(true);
      for (const ev of trace) {
        if (ac.signal.aborted) return;
        ingest(ev);
        await new Promise((r) =>
          setTimeout(r, ev.t === "text_delta" || ev.t === "thinking_delta" ? 22 : 90),
        );
      }
      finish();
    },
    [ingest, finish],
  );

  const loadMock = useCallback(() => {
    if (abortRef.current) return;
    setMessages((prev) => [...prev, { role: "user", content: MOCK_USER_MESSAGE }]);
    void playTrace(mockTrace);
  }, [playTrace]);

  const reset = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    asstRef.current = "";
    thinkRef.current = "";
    sawTurnEndRef.current = false;
    setEvents([]);
    setMessages([]);
    setAssistantText("");
    setThinkingText("");
    setError(null);
    setIsStreaming(false);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok && res.status !== 404) {
        setError(`Reset: /api/session responded ${res.status} (local state cleared anyway).`);
      }
    } catch {
      /* endpoint may not exist yet — the local reset above is the fallback */
    }
  }, [sessionId]);

  return {
    events,
    messages,
    assistantText,
    thinkingText,
    isStreaming,
    error,
    sendMessage,
    reset,
    loadMock,
  };
}
