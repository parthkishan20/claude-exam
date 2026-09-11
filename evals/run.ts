/**
 * Scenario runner.
 *
 *   npm run eval            → live if credentials exist, else scripted (offline)
 *   REPLAY=1 npm run eval   → force scripted/offline, never touch the API
 *   LIVE=1   npm run eval   → force live; fail loudly if no credentials
 *   RECORD=1 npm run eval   → live, and write evals/fixtures/<id>.json
 *   npm run eval <id> ...   → only the named scenarios
 *
 * Assertions run identically against a live trace and a scripted one — the
 * whole point of routing both through evals/scenarios.ts::expect().
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, type Scenario } from "./scenarios";
import { liveAvailable, runFromFixture, runLive, runScripted, type TraceRun } from "./harness";
import { existsSync, readFileSync } from "node:fs";

const FIXTURE_DIR = join(process.cwd(), "evals", "fixtures");

const wantReplay = process.env.REPLAY === "1";
const wantFixtures = process.env.FIXTURES === "1";
const wantLive = process.env.LIVE === "1";
const wantRecord = process.env.RECORD === "1";
const only = process.argv.slice(2);

const RESET = "\x1b[0m";
const green = (s: string) => `\x1b[32m${s}${RESET}`;
const red = (s: string) => `\x1b[31m${s}${RESET}`;
const dim = (s: string) => `\x1b[2m${s}${RESET}`;
const bold = (s: string) => `\x1b[1m${s}${RESET}`;

async function pickMode(): Promise<"live" | "scripted" | "fixtures"> {
  if (wantFixtures) return "fixtures";
  if (wantReplay) return "scripted";
  if (wantLive || wantRecord) {
    if (!(await liveAvailable())) {
      console.error(red("LIVE/RECORD requested but no Anthropic credentials are available."));
      process.exit(2);
    }
    return "live";
  }
  return (await liveAvailable()) ? "live" : "scripted";
}

async function main(): Promise<void> {
  const mode = await pickMode();
  const scenarios = only.length
    ? SCENARIOS.filter((s) => only.includes(s.id))
    : SCENARIOS;

  if (!scenarios.length) {
    console.error(red(`No scenarios matched: ${only.join(", ")}`));
    process.exit(2);
  }

  console.log(
    bold(`\nRefund-agent scenario suite`),
    dim(
      `— ${mode} mode` +
        (mode === "scripted" ? " (offline; scripted model, real backend)" : "") +
        (mode === "fixtures" ? " (offline; recorded traces, no backend)" : ""),
    ),
    "\n",
  );
  if (wantRecord) mkdirSync(FIXTURE_DIR, { recursive: true });

  let failed = 0;
  const rows: { id: string; ok: boolean; passed: number; total: number }[] = [];

  for (const scenario of scenarios) {
    let run: TraceRun;
    if (mode === "fixtures") {
      const fp = join(FIXTURE_DIR, `${scenario.id}.json`);
      if (!existsSync(fp)) {
        console.log(`${red("FAIL")}  ${bold(scenario.id)}  ${dim("no fixture — run `RECORD=1 npm run eval` first")}\n`);
        failed += 1;
        rows.push({ id: scenario.id, ok: false, passed: 0, total: 1 });
        continue;
      }
      run = runFromFixture(scenario.id, JSON.parse(readFileSync(fp, "utf8")));
    } else if (mode === "live") {
      run = await runLive(scenario);
    } else {
      run = await runScripted(scenario);
    }

    if (wantRecord) {
      writeFileSync(
        join(FIXTURE_DIR, `${scenario.id}.json`),
        JSON.stringify({ scenarioId: scenario.id, ...run }, null, 2) + "\n",
      );
    }

    const assertions = scenario.expect(run.events, run.world);
    const passed = assertions.filter((a) => a.pass).length;
    const ok = passed === assertions.length && !run.events.some((e) => e.t === "error");
    if (!ok) failed += 1;
    rows.push({ id: scenario.id, ok, passed, total: assertions.length });

    console.log(`${ok ? green("PASS") : red("FAIL")}  ${bold(scenario.id)}  ${dim(scenario.title)}`);
    for (const a of assertions) {
      console.log(`   ${a.pass ? green("✓") : red("✗")} ${a.pass ? dim(a.label) : a.label}`);
    }
    const errs = run.events.filter((e) => e.t === "error") as Extract<
      (typeof run.events)[number],
      { t: "error" }
    >[];
    for (const e of errs) console.log(`   ${red("!")} trace error: ${e.message}`);
    console.log(`   ${dim(`tools: ${run.events.filter((e) => e.t === "tool_use").map((e) => (e as { name: string }).name).join(" → ") || "none"}`)}`);
    console.log();
  }

  const total = rows.length;
  const passN = rows.filter((r) => r.ok).length;
  console.log(bold(`${passN}/${total} scenarios passed`));
  if (wantRecord) console.log(dim(`fixtures written to evals/fixtures/`));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(red("\nrunner crashed:"), err);
  process.exit(3);
});

export type { Scenario };
