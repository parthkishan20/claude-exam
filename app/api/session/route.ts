/**
 * Session reset — drops the in-memory tool store for a sessionId and re-seeds
 * it from lib/store/seed.ts. The conversation transcript lives client-side, so
 * this resets SIDE EFFECTS only: orders, refunds, credits, escalations and the
 * gateway attempt counters.
 *
 * WAVE 1 — AGENT C owns this file.
 *
 *   POST /api/session { "sessionId": string } -> { sessionId, reset: true, ... }
 */
import { resetSession } from "@/lib/store/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return Response.json(
      { error: "Request body must include a non-empty string `sessionId`." },
      { status: 400 },
    );
  }

  const store = resetSession(sessionId);
  return Response.json(
    {
      sessionId,
      reset: true,
      orders: store.orders.size,
      accounts: store.accounts.size,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
