#!/usr/bin/env node
// Stable loader for installed copies (also the Claude Desktop .mcpb entry point).
// Picks the active verified version from <MPR_ROOT>/current.json and falls back to the previous one
// (then to the code bundled next to this file) if the active version fails to load.
//   node loader.mjs server | cli <args…> | autopilot
// Deliberately dependency-free and tiny: it must keep working even if an update is broken.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = process.env.MPR_ROOT || path.join(os.homedir(), ".mpr");
process.env.MPR_ROOT = ROOT;
const mode = process.argv[2] || "server";
const entry = { server: "src/server.js", cli: "src/cli.js", autopilot: "src/cli.js" }[mode];
if (!entry) { console.error("usage: loader.mjs server|cli|autopilot"); process.exit(2); }
if (mode === "cli") process.argv.splice(2, 1);                 // cli.js reads argv[2+]
if (mode === "autopilot") process.argv.splice(2, 1, "autopilot");

let cur = {};
try { cur = JSON.parse(fs.readFileSync(path.join(ROOT, "current.json"), "utf8")); } catch {}
// Code shipped alongside this loader: <pkg>/src/loader.mjs (Desktop bundle / npm package) → <pkg>.
const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = [path.dirname(here), here].find((d) => fs.existsSync(path.join(d, entry)));
const candidates = [cur.dir, cur.previous?.dir, bundled].filter((d, i, a) => d && a.indexOf(d) === i && fs.existsSync(path.join(d, entry)));

for (const dir of candidates) {
  try {
    process.env.MPR_PACKAGE_DIR = dir;
    await import(pathToFileURL(path.join(dir, entry)).href);
    if (dir !== cur.dir && cur.dir) {
      // Active version failed to load: record it so the updater rolls back for good.
      try { fs.writeFileSync(path.join(ROOT, "current.json"), JSON.stringify({ ...cur.previous, failed: cur.version, failed_at: new Date().toISOString() }, null, 2)); } catch {}
    }
    break;
  } catch (e) {
    console.error(`[mpr loader] ${dir} failed to load: ${e.message}`);
    if (dir === candidates.at(-1)) process.exit(1);
  }
}
