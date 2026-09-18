import type { NextConfig } from "next";

/**
 * Two builds come out of this one config.
 *
 *   default            a Node server — `next dev` / `next start`. The API
 *                      routes exist, and Live mode is possible.
 *   STATIC_EXPORT=1    a folder of files for a host that runs nothing, such as
 *                      GitHub Pages. Driven by scripts/build-static.mjs.
 *
 * The static build cannot contain the route handlers at all: every one of them
 * is `dynamic = "force-dynamic"`, which `output: "export"` rejects outright.
 * The build script moves `app/api` aside for the duration and the demo reads
 * prebuilt JSON instead — see lib/demo/source.ts.
 */
const staticExport = process.env.STATIC_EXPORT === "1";

/**
 * A GitHub Pages PROJECT site is served from `https://<user>.github.io/<repo>`,
 * so every asset and link needs the `/<repo>` prefix. Set to "" for a user site
 * or a custom domain. The workflow derives it from the repository name.
 */
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
/**
 * Next rejects a basePath of "/" — the root has to be the empty string. The
 * Pages workflow's `configure-pages` action emits "/" for a user site or a
 * custom domain, so normalise it here rather than making the workflow do it.
 * A trailing slash is trimmed for the same reason.
 */
const basePath = rawBasePath === "/" ? "" : rawBasePath.replace(/\/$/, "");

const nextConfig: NextConfig = {
  // The dev badge renders over the demo stage's act title at /demo. Compile and
  // runtime errors still surface without it.
  devIndicators: false,

  ...(staticExport
    ? {
        output: "export" as const,
        // `/demo` is emitted as `demo/index.html` rather than `demo.html`, which
        // is what GitHub Pages resolves a bare `/demo` request to.
        trailingSlash: true,
        // There is no image optimizer on a static host.
        images: { unoptimized: true },
        ...(basePath ? { basePath, assetPrefix: basePath } : {}),
        // The export build deliberately has no app/api, so the tests that
        // import those route handlers cannot type-check against this tree.
        // They are excluded here rather than switching type checking off —
        // everything that actually ships is still checked, and `npm run
        // typecheck` covers the complete tree including the tests.
        typescript: { tsconfigPath: "tsconfig.static.json" },
      }
    : {}),
};

export default nextConfig;
