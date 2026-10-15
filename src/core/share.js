// File / draft sharing inside a collaboration grant.
// Sender: chunked signed envelopes (attachments.artifact), server-enforced deny-list and size caps.
// Receiver: reassemble under data/files/<thread>/, verify sha256, never execute.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { MPR_ROOT } from "./store.js";

export const MAX_FILE = 1024 * 1024;          // 1 MB per file
export const MAX_THREAD = 5 * 1024 * 1024;    // 5 MB shared per thread
const CHUNK = 24 * 1024;                      // raw bytes per envelope: base64 ≈ 32 KB, sealed (base64 again) ≈ 44 KB, under the relay's 64 KB

const home = os.homedir();
const DENY_DIRS = [MPR_ROOT, path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".gnupg"), path.join(home, ".config"),
  path.join(home, "Library", "Keychains"), path.join(home, "Library", "Application Support", "MeatProxyRemover"), path.join(home, ".claude"),
  // App data that holds sessions, tokens or MCP secrets.
  path.join(home, "Library", "Application Support", "Claude"), path.join(home, "Library", "Application Support", "Google"),
  path.join(home, "Library", "Application Support", "Firefox"), path.join(home, "Library", "Application Support", "BraveSoftware"),
  path.join(home, "Library", "Application Support", "Microsoft Edge"), path.join(home, "Library", "Safari"), path.join(home, "Library", "Cookies"),
  path.join(home, "Library", "Mail"), path.join(home, "Library", "Messages"), path.join(home, "Library", "Containers"),
  path.join(home, "AppData"), path.join(home, ".kube"), path.join(home, ".docker"), path.join(home, ".npmrc"), path.join(home, ".netrc")];
const DENY_NAMES = [/^\.env/i, /\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|ovpn|ppk|sqlite|db)$/i, /^id_(rsa|ed25519|ecdsa|dsa)/i,
  /^(identity|release-key|credentials?|secrets?|token|tokens|cookies|login data|claude_desktop_config)(\.json)?$/i, /^(cookies|login data|web data)$/i];

export function checkShareable(filePath, { dataDir, shareRoots } = {}) {
  const real = fs.realpathSync(path.resolve(filePath));
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error("Only regular files can be shared.");
  if (st.size > MAX_FILE) throw new Error(`File is ${Math.round(st.size / 1024)} KB; the limit is ${MAX_FILE / 1024} KB per file.`);
  const deny = [...DENY_DIRS, dataDir].filter(Boolean).map((d) => { try { return fs.realpathSync(d); } catch { return d; } });
  if (deny.some((d) => real === d || real.startsWith(d + path.sep))) throw new Error("That location is never shareable (keys, credentials, MPR data, config).");
  const parts = real.split(path.sep);
  if (parts.some((p) => p.startsWith(".") && p.length > 1)) throw new Error("Hidden files and folders are never shareable.");
  if (DENY_NAMES.some((r) => r.test(path.basename(real)))) throw new Error("That file type/name is never shareable (keys, secrets, credentials).");
  if (shareRoots?.length) {
    const roots = shareRoots.map((r) => { try { return fs.realpathSync(r.replace(/^~/, home)); } catch { return r; } });
    if (!roots.some((r) => real.startsWith(r + path.sep))) throw new Error("File is outside the share_roots in your policy.");
  }
  return { real, size: st.size };
}

export function chunkify(name, buf, mime) {
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const id = crypto.randomBytes(6).toString("hex");
  const parts = Math.max(1, Math.ceil(buf.length / CHUNK));
  const out = [];
  for (let i = 0; i < parts; i++) {
    out.push({ id, name: path.basename(name).slice(0, 120), mime: mime || guessMime(name), size: buf.length, sha256, part: i + 1, parts,
      data: buf.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64") });
  }
  return out;
}

/** Store one inbound chunk; returns { complete, path?, ok? } */
export function receiveChunk(filesDir, thread, a) {
  const safeThread = String(thread).replace(/[^A-Za-z0-9_-]/g, "_");
  const safeName = path.basename(String(a.name || "file")).replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "") || "file";
  const dir = path.join(filesDir, safeThread);
  if (!/^[a-f0-9]{6,64}$/.test(String(a.id))) throw new Error("bad file id");
  const tmp = path.join(dir, ".parts", String(a.id));
  fs.mkdirSync(tmp, { recursive: true });
  if (!(a.part >= 1 && a.part <= a.parts && a.parts <= Math.ceil(MAX_FILE / (16 * 1024)) + 1)) throw new Error("bad chunk numbering");
  const data = Buffer.from(String(a.data || ""), "base64");
  // Enforce the size limits on the receiving side too (a trusted contact can't fill the disk).
  if (data.length > 64 * 1024 || a.size > MAX_FILE) throw new Error("file too large");
  if (dirSize(dir) + data.length > MAX_THREAD * 2) throw new Error("thread file budget exceeded");
  fs.writeFileSync(path.join(tmp, String(a.part)), data);
  const have = fs.readdirSync(tmp).length;
  if (have < a.parts) return { complete: false, have, parts: a.parts };
  const buf = Buffer.concat(Array.from({ length: a.parts }, (_, i) => fs.readFileSync(path.join(tmp, String(i + 1)))));
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  fs.rmSync(tmp, { recursive: true, force: true });
  if (sha !== a.sha256) return { complete: true, ok: false, error: "sha256 mismatch — file discarded" };
  let dest = path.join(dir, safeName);
  if (fs.existsSync(dest)) dest = path.join(dir, `${path.parse(safeName).name}-${a.id}${path.parse(safeName).ext}`);
  fs.writeFileSync(dest, buf, { mode: 0o644 });
  return { complete: true, ok: true, path: dest, size: buf.length, sha256: sha };
}

function dirSize(d) {
  let n = 0;
  try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch {}
  return n;
}

function guessMime(n) {
  const e = path.extname(n).toLowerCase();
  return { ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".png": "image/png", ".jpg": "image/jpeg", ".html": "text/html" }[e] || "application/octet-stream";
}
