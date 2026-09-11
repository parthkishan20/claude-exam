"use client";

/**
 * Chat — left column. Message list (user + assistant), assistant text built by
 * concatenating text_delta events upstream, optional collapsible summarized
 * thinking, an input disabled while a turn streams, and a control row with the
 * RETRY_MODE indicator + Reset session.
 */
import { useState } from "react";
import { LIMITS, RETRY_MODE } from "@/lib/config";
import type { ChatMessage } from "@/lib/useAgentStream";

interface Props {
  messages: ChatMessage[];
  assistantText: string;
  thinkingText: string;
  isStreaming: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onReset: () => void;
  onLoadMock?: () => void;
}

export default function Chat({
  messages,
  assistantText,
  thinkingText,
  isStreaming,
  error,
  onSend,
  onReset,
  onLoadMock,
}: Props) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setDraft("");
  };

  const showLive = isStreaming && (assistantText.length > 0 || thinkingText.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* control row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2.5 text-xs">
        <Badge label="RETRY_MODE" value={RETRY_MODE} />
        <Badge label="refund gate" value={`> $${LIMITS.refundEscalationThreshold}`} />
        <Badge label="credit ceiling" value={`$${LIMITS.storeCreditCeiling}`} />
        <div className="ml-auto flex items-center gap-1">
          {onLoadMock && (
            <button
              onClick={onLoadMock}
              disabled={isStreaming}
              className="rounded-md px-2 py-1 font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-40"
            >
              Load sample trace
            </button>
          )}
          <button
            onClick={onReset}
            className="rounded-md px-2 py-1 font-medium text-slate-600 hover:bg-slate-100"
          >
            Reset session
          </button>
        </div>
      </div>

      {/* messages */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !showLive && (
          <p className="mt-10 text-center text-sm text-slate-400">
            Ask the refund agent something, or load a sample trace.
          </p>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {showLive && (
          <MessageBubble
            message={{
              role: "assistant",
              content: assistantText,
              thinking: thinkingText || undefined,
            }}
            live
          />
        )}
        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}
      </div>

      {/* input */}
      <div className="border-t border-slate-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={
              isStreaming
                ? "Streaming…"
                : "Refund my order ORD-1234, $120, it was damaged"
            }
            disabled={isStreaming}
            className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:bg-slate-50 disabled:text-slate-400"
          />
          <button
            onClick={submit}
            disabled={isStreaming || draft.trim().length === 0}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Badge({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
      {label}
      <span className="font-mono text-slate-900">{value}</span>
    </span>
  );
}

function MessageBubble({ message, live }: { message: ChatMessage; live?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={isUser ? "max-w-[85%]" : "w-full max-w-[95%] space-y-1.5"}>
        {!isUser && message.thinking && (
          <details className="rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
            <summary className="cursor-pointer select-none font-medium text-slate-400">
              thinking
            </summary>
            <p className="mt-1 whitespace-pre-wrap font-mono leading-relaxed">
              {message.thinking}
            </p>
          </details>
        )}
        <div
          className={
            isUser
              ? "rounded-2xl rounded-br-sm bg-slate-900 px-3.5 py-2 text-sm text-white"
              : "rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm text-slate-800"
          }
        >
          <span className="whitespace-pre-wrap">{message.content}</span>
          {live && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-slate-400 align-middle" />
          )}
        </div>
      </div>
    </div>
  );
}
