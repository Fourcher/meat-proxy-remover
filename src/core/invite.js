// Invites: how two people's AIs get connected. Human A asks their AI to invite B; human B says yes to their AI.
//
// The inviter's AI parks its first note in a throwaway relay mailbox ("inv-xxxx") owned by a one-time key, and
// hands out a short code containing that key. B's AI installs MPR, reads the note with the code, and says hello.
// From then on the two AIs pass notes directly.
//
// Security: the note is signed by the inviter's real key and the code pins that key's fingerprint. Saying hello
// proves possession of the code, and the inviter connects only the FIRST valid redeemer, so a leaked code is useless.
import crypto from "node:crypto";
import { generateKeypair, signString, verifyString, verifyObject, fingerprint, newId } from "./crypto.js";
import { buildEnvelope } from "./envelope.js";
import { deliver, collect, registerWithRelay } from "./transports.js";
import { TRUST } from "./meta.js";

export function encodeCode(obj) {
  return "mpr1:" + Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function decodeCode(code) {
  const m = String(code || "").match(/mpr1:([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("No invite code (mpr1:…) found.");
  const obj = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  for (const k of ["r", "h", "k", "f"]) if (!obj[k]) throw new Error(`Invite code is missing "${k}".`);
  return obj;
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** Inviter side: park the first note and return the message the human sends (email, text, Slack). */
export async function createInvite(mpr, { to_principal, text, summary, ask, context, human_line, approval }) {
  const me = mpr.requireIdentity();
  const relay = me.transports?.relay;
  if (!relay) throw new Error("Invites need a relay. Check your MPR setup with mpr_doctor.");
  if (!to_principal) throw new Error("to_principal (the person's name) is required.");
  text = String(text ?? [summary, ask, context].filter(Boolean).join("\n\n")).trim();
  if (!text) throw new Error("text is required: the first note for their AI (what you need from them).");

  const eph = generateKeypair();
  const invHandle = "inv-" + crypto.randomBytes(6).toString("hex");
  const reg = await registerWithRelay({ handle: invHandle, publicKey: eph.publicKey, privateKey: eph.privateKey, transports: { relay } });
  if (!reg?.ok) throw new Error(`Relay refused the invite mailbox: ${reg?.status} ${reg?.detail}`);

  const thread = newId("thr");
  const first = text.split("\n")[0].slice(0, 200);
  const env = buildEnvelope(me, { thread, to_handle: invHandle, to_principal, intent: "ask", summary: first,
    context: text.length > first.length ? text : null, attachments: { card: mpr.card() } });
  const delivery = await deliver(env, { handle: invHandle, transports: { relay } });
  if (!delivery[0]?.ok) throw new Error("Could not park the invite on the relay: " + JSON.stringify(delivery));

  const code = encodeCode({ r: relay, h: invHandle, k: eph.privateKey, f: fingerprint(me.publicKey) });
  mpr.store.updateInvites((all) => { all.push({ id: newId("inv"), inv_handle: invHandle, eph_pub: eph.publicKey, thread, to_principal,
    created: new Date().toISOString(), status: "pending", envelope_id: env.id }); });
  mpr.store.putRecord({ id: env.id, kind: "outbound", at: env.created, thread, to_handle: invHandle, envelope: env, delivery });
  mpr.store.appendThread(thread, { direction: "out", envelope_id: env.id, to: to_principal, text: text.slice(0, 2000), invite: true });
  mpr.approve(thread, approval);

  return {
    thread,
    message_text: inviteText({ me, toName: to_principal, code, text, humanLine: human_line }),
    next: "Show your principal message_text. With their OK, they (or you) send it to the person by email, text or Slack. " +
      "When their AI connects, its reply arrives in mpr_inbox.",
  };
}

export function inviteText({ me, toName, code, text, humanLine }) {
  const first = toName.split(/\s+/)[0];
  const BASE = TRUST.latest_url.replace(/\/latest\.json$/, "");
  return [
    humanLine || `Hi ${first}, my AI has a question for yours, so neither of us has to pass notes back and forth.`,
    `Just hand this message to your AI assistant (Claude, ChatGPT/Codex, Cursor…).`,
    "",
    "──────── For your AI assistant ────────",
    `${me.principal}'s AI wants to talk with you directly, using Meat Proxy Remover (MPR). Its first note:`,
    "",
    text.split("\n").map((l) => "  > " + l).join("\n"),
    "",
    `Ask your human one question first: "${me.principal}'s AI wants to work this out with me directly. OK to install Meat Proxy Remover ` +
      `(open source; it only passes notes between our AIs, signed and encrypted) and have me work it through with their AI until it's done, ` +
      `checking with you before anything that costs money, commits you, or shares private details?"`,
    `If they say yes, connect, passing their yes in their own words as the approval (this installs MPR if needed, verifies the download, ` +
      `and keeps you on the task until it's done):`,
    `  macOS/Linux:  F="\${TMPDIR:-/tmp}/mpr-install.sh"; curl -fsSL ${BASE}/install.sh -o "$F" && bash "$F" connect ${shq(code)} --name "<your human's name>" --approval "<their yes, in their words>"`,
    `  Windows:      ${BASE}/install.ps1 with -Code ${shq(code)} -Name "<your human's name>" -Approval "<their yes, in their words>"`,
    `  Already have MPR: call mpr_accept_invite with the code and approval (their yes, in their words).`,
    `  Instructions for every app: ${BASE}/install.md. Only install from that address.`,
    `Invite code: ${code}`,
    `${me.principal}'s fingerprint: ${fingerprint(me.publicKey)}`,
  ].join("\n");
}

/** Recipient side: redeem a code. Creates an identity if needed, connects to the inviter, says hello. */
export async function acceptInvite(mpr, { code, principal, handle, approval }) {
  const c = decodeCode(code);
  c.r = (TRUST.relay_moves || {})[c.r] || c.r; // codes minted before a relay move still work
  if (!/^https:\/\//.test(c.r) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(c.r)) throw new Error("Invite names a relay that isn't https. Refusing.");
  const official = TRUST.maintainer_card?.transports?.relay;
  const relayNote = official && c.r !== official ? `This invite uses a self-hosted relay (${new URL(c.r).host}). Notes stay end-to-end encrypted, but its operator can see who talks to whom, and when.` : null;
  const items = await collect({ handle: c.h, privateKey: c.k, publicKey: derivePublic(c.k), transports: { relay: c.r } });
  const found = items.find((i) => i.raw && i.raw.attachments?.card);
  if (!found) {
    const err = items.find((i) => i.error);
    throw new Error(err ? "Couldn't read the invite from the relay: " + err.error : "Invite not found. It was already used, it expired (14 days), or the code is wrong.");
  }
  const env = found.raw;
  if (!verifyObject(env, env.from?.key)) throw new Error("Invite signature is invalid. Refusing.");
  if (fingerprint(env.from.key) !== c.f) throw new Error("Invite was signed by a different key than the code names. Refusing.");
  const card = env.attachments.card;
  if (card.key !== env.from.key || !verifyObject(card, card.key)) throw new Error("Inviter's card doesn't match the invite. Refusing.");

  let me = mpr.store.getIdentity();
  if (!me) {
    const name = principal || env.to?.principal;
    if (!name) throw new Error("Your human's name is needed (principal).");
    await mpr.setup({ principal: name, handle, relay: c.r });
    me = mpr.store.getIdentity();
  } else if (!me.transports?.relay) {
    await mpr.setup({ relay: c.r });
    me = mpr.store.getIdentity();
  }
  const reg = await registerWithRelay(me);
  if (reg && !reg.ok && reg.status !== 409) throw new Error(`Relay registration failed: ${reg.status} ${reg.detail}`);

  const existing = mpr.store.getContact(card.handle);
  if (existing && existing.key !== card.key) throw new Error(`You already have a different @${card.handle}. Refusing to overwrite.`);
  if (!existing) mpr.addContact({ card_text: JSON.stringify(card), note: "connected by invite" });

  mpr.approve(env.thread, approval); // before the first note, so it carries the approval too
  const first = mpr.processInbound(env, "invite", { acceptAddressee: c.h });
  if (first.note) mpr.markShown([first.note]); // returned to the caller right here, so it's shown
  await found.ack(); // single use: the invite disappears from the relay

  // Say hello; the proof shows we hold the code, so the inviter connects our key.
  const proof = signString(`redeem:${c.h}:${me.publicKey}`, c.k);
  const contact = mpr.contact(card.handle);
  const hello = await mpr.deliverNote(contact, { thread: env.thread, in_reply_to: env.id, done: true,
    text: `${me.principal}'s AI is connected and will reply here.`, attachments: { card: mpr.card(), invite_redeem: { inv: c.h, proof } } });
  if (!hello.sent) throw new Error(`Connected here, but the hello to ${card.principal}'s AI didn't go through (${hello.error || "relay unreachable"}). Run mpr_doctor and try again.`);
  return {
    connected_to: { principal: card.principal, handle: card.handle, fingerprint: fingerprint(card.key) },
    you: mpr.publicIdentity(),
    ...(relayNote ? { relay_note: relayNote } : {}),
    their_note: first.note || null,
    next: `Reply to their note with mpr_send (to "${card.handle}", thread "${env.thread}"), then mpr_inbox {"wait_sec": 600, "thread": "${env.thread}"} for the answer.`,
  };
}

/** Inviter side: connect the first redeemer that proves it holds the code. */
export function bindRedeemer(mpr, env) {
  const r = env.attachments?.invite_redeem;
  const inv = mpr.store.getInvites().find((i) => i.inv_handle === r?.inv);
  if (!inv) return { bound: false, reason: "unknown invite" };
  if (inv.status === "redeemed") return inv.redeemer_key === env.from.key ? { bound: true, already: true } : { bound: false, reason: "invite already used" };
  if (!verifyString(`redeem:${r.inv}:${env.from.key}`, r.proof, inv.eph_pub)) return { bound: false, reason: "bad proof" };
  const card = env.attachments.card;
  if (!card || card.key !== env.from.key || !verifyObject(card, card.key)) return { bound: false, reason: "card missing or mismatched" };
  const existing = mpr.store.getContact(card.handle);
  if (existing && existing.key !== card.key) return { bound: false, reason: `@${card.handle} is already someone else` };
  if (!existing) mpr.addContact({ card_text: JSON.stringify(card), note: `accepted your invite` });
  mpr.store.updateInvites((all) => {
    const i = all.find((x) => x.inv_handle === r.inv);
    if (i) Object.assign(i, { status: "redeemed", redeemer_key: card.key, redeemed_at: new Date().toISOString(), redeemer_handle: card.handle });
  });
  return { bound: true, handle: card.handle, principal: card.principal };
}

function derivePublic(privB64) {
  const k = crypto.createPrivateKey({ key: Buffer.from(privB64, "base64"), format: "der", type: "pkcs8" });
  return crypto.createPublicKey(k).export({ type: "spki", format: "der" }).toString("base64");
}

