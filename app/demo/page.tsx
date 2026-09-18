/**
 * /demo - presenter-driven walkthrough of the refund agent.
 *
 * The act lives in the URL (`/demo?act=<id>`) so a presenter can reload or
 * link straight into one. `searchParams` is a promise in this version, and
 * reading it opts the route into dynamic rendering, which is what we want:
 * there is nothing here worth prerendering.
 */
import { Suspense } from "react";
import type { Metadata } from "next";
import DemoShell from "@/components/demo/DemoShell";

export const metadata: Metadata = {
  title: "Demo Mode | Refund-Support Agent",
  description:
    "A five-act walkthrough of the refund agent: the hook gate, the retry policy, the handlers and the store, one trace event at a time.",
};

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const act = (await searchParams).act;
  const initialActId = typeof act === "string" && act.length > 0 ? act : null;

  return (
    // DemoShell reads the live search params on the client (back / forward
    // still change acts), which needs a Suspense boundary above it.
    <Suspense fallback={<DemoBoot />}>
      <DemoShell initialActId={initialActId} />
    </Suspense>
  );
}

/**
 * The boot frame. Shaped like the screen it is about to become, so the first
 * paint in front of a room is the stage arriving rather than a white flash.
 */
function DemoBoot() {
  return (
    <div
      className="flex h-[100dvh] flex-col overflow-hidden font-sans"
      style={{ background: "#0b0d11", color: "#eef2f7" }}
    >
      <div
        className="shrink-0 border-b px-5 py-5"
        style={{ borderColor: "#1a212a" }}
      >
        <p
          className="font-mono text-[11px] tracking-[0.18em] uppercase"
          style={{ color: "#5f6a79" }}
        >
          Demo mode
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-tight xl:text-[2.5rem]">
          Setting the stage
        </p>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className="hidden w-[224px] shrink-0 border-r lg:block xl:w-[268px]"
          style={{ borderColor: "#1a212a" }}
        />
        <div className="min-h-0 flex-1 px-5 py-4">
          <div
            className="h-full w-full rounded-[6px]"
            style={{ background: "#12161c" }}
          />
        </div>
        <div
          className="hidden w-[300px] shrink-0 border-l xl:block xl:w-[360px]"
          style={{ borderColor: "#1a212a" }}
        />
      </div>
    </div>
  );
}
