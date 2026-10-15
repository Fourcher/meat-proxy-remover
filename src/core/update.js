// Signed auto-update for installed copies (~/.mpr). Never runs for the maintainer's dev/service install.
//   latest.json (public bucket) is signed by the release key pinned in src/trust.json.
//   We install only if: signature verifies, version is strictly newer, tarball sha256 matches,
//   and the new version passes `selftest`. Then current.json flips to it (previous kept for rollback).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { verifyObject } from "./crypto.js";
import { TRUST, VERSION, cmpVersion, PACKAGE_ROOT } from "./meta.js";
import { MPR_ROOT } from "./store.js";

const CURRENT = () => path.join(MPR_ROOT, "current.json");
const STATE = () => path.join(MPR_ROOT, "update-state.json");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

export function managedInstall() {
  const cur = readJson(CURRENT(), null);
  return cur && cur.dir ? cur : null;
}

export async function fetchLatest() {
  const res = await fetch(TRUST.latest_url + "?t=" + Date.now(), { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`latest.json: HTTP ${res.status}`);
  const latest = await res.json();
  // Any listed release key is accepted (primary + offline recovery key), so a lost key never strands installs.
  const keys = [TRUST.release_pubkey, ...(TRUST.release_pubkeys || [])];
  if (!keys.some((k) => verifyObject(latest, k))) throw new Error("latest.json signature is INVALID — refusing to update");
  return latest;
}

// Async child process (never blocks the MCP server); npm is npm.cmd on Windows, which needs a shell.
function run(cmd, args, { timeout = 240000, env = process.env } = {}) {
  const win = process.platform === "win32" && /^npm$/.test(cmd);
  return new Promise((resolve) => {
    const p = spawn(win ? "npm.cmd" : cmd, args, { env, shell: win });
    let out = "";
    const timer = setTimeout(() => { p.kill(); out += "\n(timed out)"; }, timeout);
    p.stdout?.on("data", (d) => (out += d)); p.stderr?.on("data", (d) => (out += d));
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
  });
}
const writeAtomic = (f, data) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); };

/** Returns { status: "skipped"|"current"|"updated"|"error", ... }. Throttled unless force. */
export async function checkForUpdate({ force = false, minIntervalMin = 15 } = {}) {
  const cur = managedInstall();
  if (!cur) return { status: "skipped", reason: "not a managed install (maintainer copy updates via release script)", version: VERSION };
  const st = readJson(STATE(), {});
  if (!force && st.last_check && Date.now() - Date.parse(st.last_check) < minIntervalMin * 60000) {
    return { status: "skipped", reason: "checked recently", version: cur.version };
  }
  // One updater at a time (MCP servers and the autopilot share this install).
  const lock = path.join(MPR_ROOT, "update.lock");
  try { fs.mkdirSync(lock); }
  catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 15 * 60000) return { status: "skipped", reason: "another process is updating", version: cur.version }; } catch {}
    fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock);
  }
  // A version the loader had to roll back from never gets reinstalled.
  const bad = new Set([...(st.bad_versions || []), ...(cur.failed ? [cur.failed] : [])]);
  const save = (extra) => writeAtomic(STATE(), JSON.stringify({ ...readJson(STATE(), {}), last_check: new Date().toISOString(), bad_versions: [...bad], ...extra }, null, 2));
  try {
    const latest = await fetchLatest();
    if (cmpVersion(latest.version, cur.version) <= 0) { save({ latest: latest.version }); return { status: "current", version: cur.version }; }
    if (bad.has(latest.version)) { save({}); return { status: "skipped", reason: `${latest.version} failed before`, version: cur.version }; }

    const res = await fetch(latest.tgz_url);
    if (!res.ok) throw new Error(`download ${latest.tgz_url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha !== latest.tgz_sha256) throw new Error("downloaded package hash mismatch — refusing");

    // Stage in a fresh folder, then move into place: a half-finished install is never the active one.
    const vdir = path.join(MPR_ROOT, "versions", latest.version);
    const stage = `${vdir}.staging-${process.pid}`;
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const tgz = path.join(stage, "pkg.tgz");
    fs.writeFileSync(tgz, buf);
    // Dependencies ship inside the signed tarball: install offline, with no install scripts.
    const npm = await run("npm", ["install", "--silent", "--no-audit", "--no-fund", "--offline", "--ignore-scripts", "--prefix", stage, tgz]);
    if (npm.code !== 0) throw new Error("npm install failed: " + npm.out.slice(0, 300));
    const test = await run(process.execPath, [path.join(stage, "node_modules", "meat-proxy-remover", "src", "cli.js"), "selftest"], { timeout: 60000, env: { ...process.env, MPR_NO_NOTIFY: "1" } });
    if (test.code !== 0) { bad.add(latest.version); throw new Error(`${latest.version} failed selftest: ${test.out.slice(0, 300)}`); }
    if (fs.existsSync(vdir) && path.resolve(vdir) !== path.resolve(path.dirname(path.dirname(cur.dir)))) fs.rmSync(vdir, { recursive: true, force: true });
    if (!fs.existsSync(vdir)) fs.renameSync(stage, vdir); else fs.rmSync(stage, { recursive: true, force: true });
    const dir = path.join(vdir, "node_modules", "meat-proxy-remover");
    writeAtomic(CURRENT(), JSON.stringify({ version: latest.version, dir, installed: new Date().toISOString(),
      previous: { version: cur.version, dir: cur.dir } }, null, 2));
    try { writeAtomic(path.join(MPR_ROOT, "loader.mjs"), fs.readFileSync(path.join(dir, "src", "loader.mjs"))); } catch {}
    save({ latest: latest.version, last_update: latest.version });
    return { status: "updated", from: cur.version, to: latest.version, notes: latest.notes || null,
      note: "New code is used by the next CLI call / next session; long-running servers pick it up on restart." };
  } catch (e) {
    save({ last_error: e.message });
    return { status: "error", error: e.message, version: cur.version };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** First-time managed setup, called by `mpr connect` from the npm-installed package. */
export function adoptCurrentPackage() {
  const loaderSrc = path.join(PACKAGE_ROOT, "src", "loader.mjs");
  fs.mkdirSync(path.join(MPR_ROOT, "bin"), { recursive: true });
  fs.copyFileSync(loaderSrc, path.join(MPR_ROOT, "loader.mjs"));
  const prev = managedInstall();
  if (!prev || cmpVersion(VERSION, prev.version) >= 0) {
    fs.writeFileSync(CURRENT(), JSON.stringify({ version: VERSION, dir: PACKAGE_ROOT, installed: new Date().toISOString(),
      previous: prev && prev.dir !== PACKAGE_ROOT ? { version: prev.version, dir: prev.dir } : null }, null, 2));
  }
  const loader = path.join(MPR_ROOT, "loader.mjs");
  // Unix shell shim, plus a .cmd twin so Windows shells (cmd/PowerShell) can run `mpr` too.
  const shim = path.join(MPR_ROOT, "bin", "mpr");
  const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`; // POSIX single-quoting: no $, backtick or quote can break out
  fs.writeFileSync(shim, `#!/bin/sh\nMPR_ROOT=${sq(MPR_ROOT)} exec ${sq(process.execPath)} ${sq(loader)} cli "$@"\n`, { mode: 0o755 });
  const cmd = path.join(MPR_ROOT, "bin", "mpr.cmd");
  fs.writeFileSync(cmd, `@echo off\r\nset "MPR_ROOT=${MPR_ROOT}"\r\n"${process.execPath}" "${loader}" cli %*\r\n`);
  return { root: MPR_ROOT, loader, cli: process.platform === "win32" ? cmd : shim };
}
