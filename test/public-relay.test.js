#!/usr/bin/env node
// Round trip through the DEPLOYED relay over the public internet (not part of `npm test`, which stays offline).
//
//   npm run test:public-relay                          # uses the hosted relay below
//   MPR_PUBLIC_RELAY=https://… npm run test:public-relay
//   MPR_PUBLIC_RELAY_TO=jordan npm run test:public-relay   # also drop one signed test FYI into that handle's
//                                                           # real mailbox (then `bin/mpr inbox` should verify it)
//
// Each run registers two throwaway identities with random `mprtest-…` handles.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MPR } from "../src/core/service.js";
import { signString } from "../src/core/crypto.js";
import { relayUrl } from "../src/core/transports.js";

const RELAY = process.env.MPR_PUBLIC_RELAY || "https://tombsuanyficmiupgdrv.supabase.co/functions/v1/mpr-relay";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "test", ".tmp-public");
fs.rmSync(tmp, { recursive: true, force: true });

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}
const tag = crypto.randomBytes(4).toString("hex");
const a = new MPR(path.join(tmp, "a"));
const b = new MPR(path.join(tmp, "b"));
console.log(`Public relay round trip → ${RELAY}`);

await t("relay is reachable over HTTPS", async () => {
  assert.ok(RELAY.startsWith("https://"), "public relay must be HTTPS");
  const r = await fetch(relayUrl(RELAY, "/healthz"));
  assert.equal(r.status, 200);
});

await t("two fresh identities register (handles pinned to keys)", async () => {
  const ra = await a.setup({ principal: "Test Sender", handle: `mprtest-a-${tag}`, relay: RELAY });
  const rb = await b.setup({ principal: "Test Receiver", handle: `mprtest-b-${tag}`, relay: RELAY });
  assert.equal(ra.relay_registration.ok, true, JSON.stringify(ra.relay_registration));
  assert.equal(rb.relay_registration.ok, true, JSON.stringify(rb.relay_registration));
  a.addContact({ card_text: b.cardText() });
  b.addContact({ card_text: a.cardText() });
});

await t("A → relay → B: delivered, signature verified, acked", async () => {
  const s = await a.send({ to: `mprtest-b-${tag}`, text: `public relay round trip ${tag}` });
  assert.equal(s.sent, true, JSON.stringify(s));
  const inbox = await b.checkInbox();
  assert.equal(inbox.new_notes.length, 1, JSON.stringify(inbox));
  const again = await b.checkInbox();
  assert.equal(again.new_notes.length, 0, "ack should have removed it from the relay");
});

await t("throwaway invite mailboxes (inv-…) register and receive like any handle", async () => {
  const inv = new MPR(path.join(tmp, "inv"));
  const r = await inv.setup({ principal: "Invite", handle: `inv-${tag}`, relay: RELAY });
  assert.equal(r.relay_registration.ok, true, JSON.stringify(r.relay_registration));
  a.addContact({ card_text: inv.cardText() });
  inv.addContact({ card_text: a.cardText() });
  assert.equal((await a.send({ to: `inv-${tag}`, text: "invite probe" })).sent, true);
  assert.equal((await inv.checkInbox()).new_notes.length, 1);
});

await t("a stranger can't claim B's handle or read B's mailbox", async () => {
  const evil = new MPR(path.join(tmp, "evil"));
  const er = await evil.setup({ principal: "Evil", handle: `mprtest-b-${tag}`, relay: RELAY });
  assert.equal(er.relay_registration.status, 409, JSON.stringify(er.relay_registration));
  const stolen = await evil.checkInbox();
  assert.equal(stolen.new_notes.length, 0);
  assert.ok(stolen.errors?.length >= 1);
});

await t("replayed read signature is refused", async () => {
  const id = JSON.parse(fs.readFileSync(path.join(tmp, "b", "identity.json"), "utf8"));
  const p = `/v1/inbox/mprtest-b-${tag}`;
  const ts = String(Date.now());
  const headers = { "x-mpr-handle": id.handle, "x-mpr-time": ts, "x-mpr-sig": signString(`GET ${p} ${ts}`, id.privateKey) };
  assert.equal((await fetch(relayUrl(RELAY, p), { headers })).status, 200);
  assert.equal((await fetch(relayUrl(RELAY, p), { headers })).status, 401);
});

await t("forged, misaddressed and oversized deposits are refused", async () => {
  const aKey = JSON.parse(fs.readFileSync(path.join(tmp, "a", "identity.json"), "utf8")).publicKey;
  const post = (handle, body) => fetch(relayUrl(RELAY, `/v1/inbox/${handle}`), {
    method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const forged = await post(`mprtest-b-${tag}`, { protocol: "mpr/1", to: { handle: `mprtest-b-${tag}` }, from: { key: aKey }, summary: "forged", sig: "AAAA" });
  assert.equal(forged.status, 400);
  // A genuinely signed envelope for B, posted into A's mailbox.
  const probe = await a.send({ to: `mprtest-b-${tag}`, text: "misaddress probe" });
  const env = a.store.getRecord(probe.id).envelope;
  assert.equal((await post(`mprtest-a-${tag}`, env)).status, 400);
  await b.checkInbox(); // drain the probe
  assert.equal((await post(`mprtest-b-${tag}`, "x".repeat(70 * 1024))).status, 400, "bodies over 64 KB are refused");
});

if (process.env.MPR_PUBLIC_RELAY_TO) {
  const to = process.env.MPR_PUBLIC_RELAY_TO;
  await t(`signed test FYI delivered to ${to}'s real mailbox`, async () => {
    // The recipient's agent card: a file path in MPR_PUBLIC_RELAY_TO_CARD, or this checkout's own data/<handle>.
    const cardFile = process.env.MPR_PUBLIC_RELAY_TO_CARD;
    const card = cardFile ? fs.readFileSync(cardFile, "utf8") : new MPR(path.join(root, "data", to)).cardText();
    a.addContact({ card_text: card, trust: "review" });
    const s = await a.send({ to, intent: "inform", summary: `MPR public relay test (${tag}): safe to ignore` });
    assert.equal(s.delivery?.[0]?.ok, true, JSON.stringify(s));
    console.log(`    sent from mprtest-a-${tag}; now run: bin/mpr inbox`);
  });
}

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
fs.rmSync(tmp, { recursive: true, force: true });
