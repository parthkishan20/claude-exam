/**
 * Where Demo Mode gets its data — the one place that knows whether a server
 * exists.
 *
 * Two hosts, one UI:
 *
 *   server  (`next dev` / `next start`)  POST /api/demo runs the act on demand,
 *                                        and live mode is possible.
 *   static  (`output: "export"`, e.g. GitHub Pages)  the runs were generated at
 *                                        build time by scripts/generateDemoRuns.ts
 *                                        and are fetched as plain JSON. There is
 *                                        no server, so there is no live mode.
 *
 * The substitution is only honest because replay is deterministic: the same
 * scenario through the same `runScripted` + `scenario.expect()` pair produces
 * the same trace, the same assertions and the same world whether it runs at
 * build time or at request time. Nothing about the enforcement is reproduced
 * or re-enacted for the static host — it genuinely ran, just earlier.
 */
import type { DemoAct, DemoMode, DemoRun } from "./types";

/**
 * Inlined at build time. Set by the static-export build (scripts/build-static.mjs);
 * absent in every server build, so the default path stays the API.
 */
export const IS_STATIC = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";

/**
 * GitHub Pages serves a project site from a sub-path (`/<repo>`). `basePath`
 * rewrites `next/link` hrefs and asset URLs automatically but does NOT touch a
 * hand-written `fetch`, so static data URLs have to carry it themselves.
 */
const RAW_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
/** Matches next.config.ts: "/" means the root, which is the empty prefix. */
const BASE_PATH = RAW_BASE_PATH === "/" ? "" : RAW_BASE_PATH.replace(/\/$/, "");

const API = "/api/demo";
const STATIC_DIR = `${BASE_PATH}/demo-runs`;

export interface DemoIndex {
  acts: DemoAct[];
  live: boolean;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** The act list, plus whether this host can run the model at all. */
export async function fetchIndex(signal?: AbortSignal): Promise<DemoIndex> {
  if (IS_STATIC) return getJson<DemoIndex>(`${STATIC_DIR}/index.json`, signal);
  return getJson<DemoIndex>(API, signal);
}

/**
 * One act's run. On the static host `mode` is ignored — there is only one
 * artefact per act and it is a replay, which is exactly what `live: false`
 * already told the UI.
 */
export async function fetchRun(
  actId: string,
  mode: DemoMode,
  signal?: AbortSignal,
): Promise<DemoRun> {
  if (IS_STATIC) {
    return getJson<DemoRun>(`${STATIC_DIR}/${encodeURIComponent(actId)}.json`, signal);
  }
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actId, mode }),
    signal,
  });
  // A 4xx from this endpoint still carries a well-formed DemoRun with `error`
  // set — "Unknown actId" tells a presenter far more than "responded 400" — so
  // prefer the body's own reason and only invent a message if there isn't one.
  const body = (await res.json().catch(() => null)) as DemoRun | null;
  if (body && typeof body.error === "string" && body.error) return body;
  if (!res.ok) throw new Error(`Could not load this act — ${API} responded ${res.status}.`);
  if (!body) throw new Error(`${API} returned a response that could not be read.`);
  return body;
}
