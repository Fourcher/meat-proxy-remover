// File-backed state. Everything lives under MPR_HOME (never the user's home folder by default).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Installed copies keep state in ~/.mpr/data (survives npx/npm cache wipes).
// Jordan's machine always sets MPR_HOME explicitly so nothing lands in the home folder.
export const MPR_ROOT = process.env.MPR_ROOT || path.join(os.homedir(), ".mpr");
export const DEFAULT_HOME = path.join(MPR_ROOT, "data");
// Settings a person may edit by hand in policy.json: notifications, and folders files may be sent from.
const DEFAULT_POLICY = { notify: true, share_roots: null };

export class Store {
  constructor(home = process.env.MPR_HOME || DEFAULT_HOME) {
    this.home = path.resolve(home);
    for (const d of ["", "threads", "records"]) fs.mkdirSync(path.join(this.home, d), { recursive: true });
  }

  // Every path stays inside the data folder, whatever a name contains.
  p(...parts) {
    const full = path.resolve(this.home, ...parts);
    if (full !== this.home && !full.startsWith(this.home + path.sep)) throw new Error("refusing a path outside the MPR data folder");
    return full;
  }

  readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.p(name), "utf8")); } catch { return fallback; }
  }

  writeJson(name, value, mode) {
    const file = this.p(name);
    // A unique temp file per write: several MPR processes (MCP servers, autopilot) share this folder.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
  }

  /** Cross-process lock (atomic mkdir), with stale-lock recovery. Returns an unlock function. */
  lock(name) {
    const dir = this.p(name + ".lock");
    const deadline = Date.now() + 10000;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try { fs.mkdirSync(dir); return () => { try { fs.rmdirSync(dir); } catch {} }; }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        try { if (Date.now() - fs.statSync(dir).mtimeMs > 15000) { fs.rmdirSync(dir); continue; } } catch {}
        if (Date.now() > deadline) throw new Error(`MPR data is busy (${name}); try again`);
        Atomics.wait(nap, 0, 0, 3 + Math.floor(Math.random() * 15));
      }
    }
  }

  /** Locked read-modify-write of one JSON file: fn(current) returns the new value (or mutates and returns nothing). */
  update(name, fallback, fn, mode) {
    const unlock = this.lock(name);
    try {
      const cur = this.readJson(name, structuredClone(fallback));
      const next = fn(cur);
      const val = next === undefined ? cur : next;
      this.writeJson(name, val, mode);
      return val;
    } finally { unlock(); }
  }

  // identity
  getIdentity() { return this.readJson("identity.json", null); }
  setIdentity(id) { this.writeJson("identity.json", id, 0o600); }

  // contacts
  getContacts() { return this.readJson("contacts.json", {}); }
  setContacts(c) { this.writeJson("contacts.json", c); }
  getContact(handle) { return this.getContacts()[normHandle(handle)] || null; }
  findContactByKey(key) { return Object.values(this.getContacts()).find((c) => c.key === key) || null; }
  putContact(contact) {
    this.update("contacts.json", {}, (all) => { all[normHandle(contact.handle)] = contact; });
  }
  updateContacts(fn) { return this.update("contacts.json", {}, fn); }

  // policy
  getPolicy() {
    const p = this.readJson("policy.json", null);
    if (!p) { this.writeJson("policy.json", DEFAULT_POLICY); return structuredClone(DEFAULT_POLICY); }
    return { ...structuredClone(DEFAULT_POLICY), ...p };
  }
  setPolicy(p) { this.writeJson("policy.json", p); }

  // records: one per envelope (in or out) or raw inbound message
  getRecord(id) { return this.readJson(path.join("records", safe(id) + ".json"), null); }
  putRecord(rec) { this.writeJson(path.join("records", safe(rec.id) + ".json"), rec); this._dirty = true; }
  /**
   * All records, oldest first. Cached per process: only files that are new or changed since the last call are re-read
   * (another MPR process may have written them), so repeated calls stay fast with thousands of records.
   * Read-only: callers must not modify the returned records (use getRecord + putRecord to change one).
   */
  listRecords() {
    const dir = this.p("records");
    const cache = (this._rec ||= new Map());
    const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const present = new Set(names);
    for (const k of cache.keys()) if (!present.has(k)) cache.delete(k);
    for (const f of names) {
      let m;
      try { m = fs.statSync(path.join(dir, f)).mtimeMs; } catch { cache.delete(f); continue; }
      const hit = cache.get(f);
      if (hit && hit.m === m) continue;
      const rec = this.readJson(path.join("records", f), null);
      if (rec) cache.set(f, { m, rec }); else cache.delete(f);
      this._dirty = true;
    }
    if (!this._sorted || this._sortedSize !== cache.size || this._dirty) {
      this._sorted = [...cache.values()].map((x) => x.rec).sort((a, b) => (a.at < b.at ? -1 : 1));
      this._sortedSize = cache.size; this._dirty = false;
    }
    return this._sorted.slice();
  }
  seen(envId) { return !!this.getRecord(envId); }
  /** Atomically claim an envelope id for processing; false if another process already did. */
  claim(envId) {
    try { fs.writeFileSync(this.p("records", safe(envId) + ".claim"), String(process.pid), { flag: "wx" }); return true; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A claim with no record after a minute means that process died mid-way: take it over so the message isn't lost.
      const f = this.p("records", safe(envId) + ".claim");
      try { if (!this.getRecord(envId) && Date.now() - fs.statSync(f).mtimeMs > 60000) { fs.writeFileSync(f, String(process.pid)); return true; } } catch {}
      return false;
    }
  }
  /** Interactive sessions touch this so the background autopilot doesn't answer the same thing twice. */
  heartbeat() { try { fs.writeFileSync(this.p("session.heartbeat"), new Date().toISOString()); } catch {} }
  sessionActiveWithin(ms) { try { return Date.now() - fs.statSync(this.p("session.heartbeat")).mtimeMs < ms; } catch { return false; } }

  // threads: append-only log
  appendThread(thread, event) {
    fs.appendFileSync(this.p("threads", safe(thread) + ".jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  }
  readThread(thread) {
    try {
      return fs.readFileSync(this.p("threads", safe(thread) + ".jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
  listThreads() {
    return fs.readdirSync(this.p("threads")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  }

  // invites we issued
  getInvites() { return this.readJson("invites.json", []); }
  setInvites(v) { this.writeJson("invites.json", v, 0o600); }
  updateInvites(fn) { return this.update("invites.json", [], fn, 0o600); }

  // error log (for doctor / issue reports)
  logError(where, message) {
    try { fs.appendFileSync(this.p("errors.jsonl"), JSON.stringify({ at: new Date().toISOString(), where, message: String(message).slice(0, 500) }) + "\n"); } catch {}
  }
  recentErrors(n = 5) {
    try { return fs.readFileSync(this.p("errors.jsonl"), "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
  }

  // misc state
  getState() { return this.readJson("state.json", {}); }
  setState(s) { this.writeJson("state.json", s); }
  /** Merge keys into state.json under the lock (never clobbers keys another process just wrote). */
  patchState(patch) { return this.update("state.json", {}, (st) => (typeof patch === "function" ? patch(st) : Object.assign(st, patch))); }
}

// Handles are [a-z0-9._-], no leading dots and no "..", so they can never act as path segments.
export function normHandle(h) {
  return String(h || "").trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 64);
}

function safe(s) { return String(s).replace(/[^A-Za-z0-9_\-]/g, "_"); }
