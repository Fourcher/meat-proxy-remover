// Where Claude Code's `claude` command is. The Claude desktop app keeps its own copy in a private folder and doesn't put
// it on PATH, so looking only at PATH misses most desktop users (their MPR install then got no tools, hook or helper).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const WIN = process.platform === "win32";
const onPath = (bin) => { try { execFileSync(WIN ? "where" : "which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
const byVersion = (a, b) => b.localeCompare(a, undefined, { numeric: true });

/** Newest copy bundled with the Claude desktop app, if any. */
function desktopBundled() {
  const base = WIN ? path.join(process.env.APPDATA || "", "Claude", "claude-code")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude", "claude-code");
  let versions = [];
  try { versions = fs.readdirSync(base).sort(byVersion); } catch { return null; }
  const leaf = WIN ? ["claude.exe"] : process.platform === "darwin" ? ["claude.app", "Contents", "MacOS", "claude"] : ["claude"];
  for (const v of versions) {
    let builds = [];
    try { builds = fs.readdirSync(path.join(base, v)); } catch { continue; }
    for (const b of builds) { const p = path.join(base, v, b, ...leaf); if (fs.existsSync(p)) return p; }
  }
  return null;
}

let cached;
/** The claude command to run: on PATH, the one running this session, or the desktop app's own. Null if none. */
export function claudeBin() {
  if (cached !== undefined) return cached;
  const candidates = [WIN ? "claude.cmd" : "claude", process.env.CLAUDE_CODE_EXECPATH, desktopBundled()].filter(Boolean);
  cached = candidates.find((c) => (path.isAbsolute(c) ? fs.existsSync(c) : onPath(c))) || null;
  return cached;
}
export const resetClaudeBin = () => { cached = undefined; };
