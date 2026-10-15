#!/usr/bin/env node
// Release guard: unattended fixes may ship on their own only if they touch docs/skill text. Any change to code that runs on
// users' machines (or the relay) needs Jordan's yes: a fix prompted by an outside bug report must never ship code by itself.
//   node scripts/guard.mjs snapshot   record hashes of all shipped source (done after every release)
//   node scripts/guard.mjs check      list changed files; exit 3 if any trust-critical file changed
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, ".guard.json");
const CRITICAL_DIRS = ["src/", "scripts/", "relay/", "packaging/", "plugin/"]; // plugin/ = the skill, which steers the autopilot
export const CRITICAL = [
  "src/core/crypto.js", "src/core/invite.js", "src/core/transports.js", "src/core/update.js", "src/core/share.js",
  "src/loader.mjs", "src/connect.js", "src/trust.json", "scripts/release.mjs", "scripts/guard.mjs", "scripts/install-service.sh",
  "relay/relay.js", "relay/supabase/mpr-relay/index.ts", "relay/supabase/mpr-publish/index.ts", "packaging/mcpb/manifest.json",
];
function files(dir = ROOT, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f), rel = path.relative(ROOT, p);
    if (/^(node_modules|\.npm-cache|dist|data|test|\.guard\.json)/.test(rel) || f.startsWith(".")) continue;
    if (fs.statSync(p).isDirectory()) files(p, out);
    else if (/\.(js|mjs|ts|json|sh|md)$/.test(f)) out.push(rel);
  }
  return out;
}
const hash = (f) => {
  let buf = fs.readFileSync(path.join(ROOT, f));
  if (f === "package.json") { const j = JSON.parse(buf); delete j.version; buf = Buffer.from(JSON.stringify(j)); } // version bumps aren't changes
  return crypto.createHash("sha256").update(buf).digest("hex");
};
export function snapshot() { fs.writeFileSync(SNAP, JSON.stringify(Object.fromEntries(files().map((f) => [f, hash(f)])), null, 1)); }
export function check() {
  const old = fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, "utf8")) : {};
  const now = Object.fromEntries(files().map((f) => [f, hash(f)]));
  const changed = [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((f) => old[f] !== now[f] && !/^plugin\/\.claude-plugin\/plugin\.json$/.test(f));
  const critical = changed.filter((f) => CRITICAL.includes(f) || CRITICAL_DIRS.some((d) => f.startsWith(d)) || f === "package.json");
  return { changed, critical };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Snapshots are taken only by release.mjs after a successful release, never by hand.
  { const r = check(); console.log(JSON.stringify(r, null, 2)); process.exit(r.critical.length ? 3 : 0); }
}
