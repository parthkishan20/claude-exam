/**
 * Prebuilds Demo Mode's data as static JSON, for hosting with no server.
 *
 * GitHub Pages serves files, not Node. `/api/demo` cannot exist there, so the
 * runs it would have produced are generated HERE, at build time, and written
 * into `public/demo-runs/` for the client to fetch.
 *
 * This is not a second implementation of the demo. It calls the same
 * `runScripted` + `scenario.expect()` pair that `app/api/demo/route.ts` calls
 * and that `npm run eval` asserts on, so a hosted act is the same act — the
 * real hook, dispatcher, retry policy, handlers and store, executed at build
 * time instead of at request time. Replay is deterministic, which is the whole
 * reason this substitution is honest: there is no per-request state to lose.
 *
 * Live mode is deliberately impossible in the static build. There is no server
 * to hold a key, and a key shipped to a static site would be public. The
 * generated index therefore pins `live: false`, which is what disables the
 * toggle in the UI.
 *
 *   npx tsx scripts/generateDemoRuns.ts [outDir]
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runScripted } from "@/evals/harness";
import { SCENARIOS } from "@/evals/scenarios";
import { DEMO_ACTS } from "@/lib/demo/acts";
import type { DemoRun } from "@/lib/demo/types";

const OUT_DIR = process.argv[2] ?? path.join(process.cwd(), "public", "demo-runs");

async function buildRun(actId: string): Promise<DemoRun> {
  const act = DEMO_ACTS.find((a) => a.id === actId);
  if (!act) throw new Error(`Unknown act ${JSON.stringify(actId)}.`);
  if (act.scenarioId === null) {
    throw new Error(`Act "${act.id}" is static and has no scenario to prebuild.`);
  }

  const scenario = SCENARIOS.find((s) => s.id === act.scenarioId);
  if (!scenario) {
    throw new Error(`Act "${act.id}" names an unknown scenario "${act.scenarioId}".`);
  }

  const run = await runScripted(scenario);
  const assertions = scenario.expect(run.events, run.world);

  return {
    actId: act.id,
    scenarioId: scenario.id,
    title: act.title,
    turns: scenario.turns,
    mode: "replay",
    events: run.events,
    assertions,
    passed: assertions.every((a) => a.pass),
    finalText: run.finalText,
    world: run.world,
    error: null,
    notice: null,
  };
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  // `live: false` is not a default here, it is a fact about the host.
  const index = { acts: DEMO_ACTS, live: false };
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(index), "utf8");

  let failures = 0;
  for (const act of DEMO_ACTS) {
    const run = await buildRun(act.id);
    await writeFile(path.join(OUT_DIR, `${act.id}.json`), JSON.stringify(run), "utf8");

    const passed = run.assertions.filter((a) => a.pass).length;
    const total = run.assertions.length;
    if (!run.passed) failures += 1;
    console.log(
      `${run.passed ? "PASS" : "FAIL"}  ${act.id.padEnd(26)} ` +
        `${String(passed).padStart(2)}/${total} assertions, ${run.events.length} events`,
    );
  }

  // A demo whose own acceptance criteria fail is not worth publishing, and a
  // silent failure here would ship a red checklist to an audience.
  if (failures > 0) {
    throw new Error(`${failures} act(s) failed their assertions — refusing to publish.`);
  }
  console.log(`\nWrote ${DEMO_ACTS.length + 1} files to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
