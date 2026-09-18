"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Chat from "@/components/Chat";
import { IS_STATIC } from "@/lib/demo/source";
import ScenarioRunner from "@/components/ScenarioRunner";
import TracePanel from "@/components/TracePanel";
import { useAgentStream } from "@/lib/useAgentStream";

/**
 * A fixed placeholder, identical on the server render and the client's first
 * render — Math.random() (or Date.now()) here would diverge between the two
 * and trigger a hydration mismatch. The real random id is assigned in a
 * useEffect, which only ever runs client-side, then the swap is a normal
 * post-hydration re-render. No request goes out before that swap — every
 * network call is user-triggered (send/reset), never on mount.
 */
const PENDING_SESSION_ID = "sess_pending";

export default function Home() {
  const [sessionId, setSessionId] = useState(PENDING_SESSION_ID);
  useEffect(() => {
    setSessionId(`sess_${Math.random().toString(36).slice(2, 10)}`);
  }, []);
  const stream = useAgentStream({ sessionId });
  const [tab, setTab] = useState<"trace" | "scenarios">("trace");
  const devMock =
    process.env.NODE_ENV !== "production" ? stream.loadMock : undefined;

  return (
    <div className="flex h-screen flex-col bg-white text-slate-900">
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
        <h1 className="text-sm font-semibold">Refund-Support Agent</h1>
        <span className="text-xs text-slate-400">playground</span>
        <Link
          href="/demo"
          className="ml-auto rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
        >
          Guided demo &rarr;
        </Link>
        <span className="font-mono text-[11px] text-slate-400">{sessionId}</span>
      </header>

      {/*
        On the static build (GitHub Pages) there is no server, so this
        playground's chat and scenario endpoints do not exist. Saying so plainly
        beats letting a visitor click Send and conclude the project is broken —
        and the guided demo beside it is fully functional there.
      */}
      {IS_STATIC ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <span className="font-semibold">This is a static copy.</span>
          <span className="text-amber-800">
            The live chat needs a server to reach the Anthropic API, so it is inert here.
          </span>
          <Link href="/demo" className="font-medium underline underline-offset-2 hover:text-amber-950">
            The guided demo works in full &rarr;
          </Link>
          <span className="text-amber-700">
            Run the chat locally with <code className="font-mono">npm run dev</code>.
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col min-[1100px]:flex-row">
        <section className="flex min-h-0 flex-col border-b border-slate-200 max-[1099px]:h-[55vh] min-[1100px]:w-[420px] min-[1100px]:border-b-0 min-[1100px]:border-r">
          <Chat
            messages={stream.messages}
            assistantText={stream.assistantText}
            thinkingText={stream.thinkingText}
            isStreaming={stream.isStreaming}
            error={stream.error}
            onSend={stream.sendMessage}
            onReset={stream.reset}
            onLoadMock={devMock}
          />
        </section>

        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex gap-1 border-b border-slate-200 px-3 py-1.5">
            <TabButton active={tab === "trace"} onClick={() => setTab("trace")}>
              Trace
            </TabButton>
            <TabButton active={tab === "scenarios"} onClick={() => setTab("scenarios")}>
              Scenarios
            </TabButton>
          </div>
          <div className="min-h-0 flex-1">
            {tab === "trace" ? (
              <TracePanel events={stream.events} />
            ) : (
              <ScenarioRunner />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-xs font-medium ${
        active ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}
