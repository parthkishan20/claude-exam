/**
 * Builds the static site for a host that runs no server (GitHub Pages).
 *
 *   npm run build:static                    # site at /
 *   NEXT_PUBLIC_BASE_PATH=/claude-exam npm run build:static
 *
 * Three things have to happen that a normal `next build` does not do:
 *
 *  1. The demo's runs are generated ahead of time into `public/demo-runs/`,
 *     because `POST /api/demo` will not exist on the host.
 *
 *  2. `app/api` is moved out of the tree for the duration of the build. Every
 *     route handler in it is `dynamic = "force-dynamic"`, which `output:
 *     "export"` refuses to build, and none of them could run on the host
 *     anyway. This is the ugly step, so it is guarded: the directory is
 *     restored in a `finally`, on SIGINT/SIGTERM, and again at the start of the
 *     next run if a previous one was killed outright.
 *
 *  3. `.nojekyll` is written into the output. Without it GitHub Pages runs the
 *     tree through Jekyll, which drops every directory beginning with an
 *     underscore — including `_next`, i.e. the entire application.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "app", "api");
const STASH_DIR = path.join(ROOT, ".static-build", "api");
const OUT_DIR = path.join(ROOT, "out");

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function run(command, args, env) {
  const res = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: false,
  });
  if (res.status !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` exited with ${res.status ?? "a signal"}.`);
  }
}

function stashApi() {
  if (!existsSync(API_DIR)) return false;
  mkdirSync(path.dirname(STASH_DIR), { recursive: true });
  renameSync(API_DIR, STASH_DIR);
  return true;
}

function restoreApi() {
  if (!existsSync(STASH_DIR)) return;
  // If a build was killed mid-flight the tree may hold both; the stash is the
  // real one, since the build never writes into app/api.
  if (existsSync(API_DIR)) {
    throw new Error(
      `Both ${API_DIR} and ${STASH_DIR} exist. Inspect them and move the stash back by hand.`,
    );
  }
  renameSync(STASH_DIR, API_DIR);
}

async function main() {
  // A previous run may have been killed before its finally block. Undo that
  // first, so a developer never has to discover it themselves.
  if (existsSync(STASH_DIR)) {
    console.log("Restoring app/api left behind by an interrupted build...");
    restoreApi();
  }

  console.log("\n[1/3] Generating demo runs...");
  run("npx", ["tsx", "scripts/generateDemoRuns.ts"]);

  let stashed = false;
  const onSignal = () => {
    if (stashed) restoreApi();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    console.log("\n[2/3] Building the static export (app/api is set aside)...");
    stashed = stashApi();
    // A previous server build leaves route types in .next that name the very
    // handlers we just moved, and they would fail the type check.
    rmSync(path.join(ROOT, ".next"), { recursive: true, force: true });
    run("npx", ["next", "build"], {
      STATIC_EXPORT: "1",
      NEXT_PUBLIC_STATIC_EXPORT: "1",
      NEXT_PUBLIC_BASE_PATH: basePath,
    });
  } finally {
    if (stashed) restoreApi();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  console.log("\n[3/3] Writing .nojekyll...");
  writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");

  console.log(
    `\nDone. Static site in ./out${basePath ? `, served under ${basePath}` : ""}.\n` +
      `Preview it with:  npx serve out${basePath ? ` -- and open ${basePath}/demo/` : ""}\n`,
  );
}

main().catch((err) => {
  console.error(`\nStatic build failed: ${err instanceof Error ? err.message : err}`);
  // Never leave the working tree broken because the build failed.
  try {
    restoreApi();
  } catch (restoreErr) {
    console.error(String(restoreErr));
  }
  process.exit(1);
});
