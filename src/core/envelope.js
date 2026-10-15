// The MPR/1 envelope: one signed note from one person's AI to another's.
// The note itself is summary (its first line) plus context (the whole text). intent says whether a reply is expected;
// older (1.x) senders used more intents and fields, which still parse.
import { newId, signObject, verifyObject, fingerprint } from "./crypto.js";

export const PROTOCOL = "mpr/1";
export const INTENTS = ["ask", "schedule", "propose", "inform", "clarify", "accept", "decline", "counter", "ack"];

const BEGIN_CARD = "-----BEGIN AGENT CARD-----";
const END_CARD = "-----END AGENT CARD-----";

export function buildEnvelope(identity, f) {
  return signObject({
    protocol: PROTOCOL,
    id: newId("env"),
    thread: f.thread || newId("thr"),
    in_reply_to: f.in_reply_to || null,
    created: new Date().toISOString(),
    from: { principal: identity.principal, agent: identity.agent, handle: identity.handle, key: identity.publicKey, enc: identity.encPublicKey || undefined },
    to: { principal: f.to_principal || null, handle: f.to_handle },
    intent: f.intent,
    summary: f.summary,
    context: f.context || null,
    attachments: f.attachments || null, // { card, invite_redeem } when connecting; { artifact } for a file chunk
  }, identity.privateKey);
}

export function validateEnvelope(env) {
  const errs = [];
  if (!env || typeof env !== "object") return ["not an object"];
  if (env.protocol !== PROTOCOL) errs.push(`protocol must be ${PROTOCOL}`);
  for (const k of ["thread", "intent", "summary"]) {
    if (typeof env[k] !== "string" || !env[k]) errs.push(`missing ${k}`);
  }
  if (!env.from || typeof env.from.handle !== "string") errs.push("missing from.handle");
  if (typeof env.sig === "string") {
    // Signed envelopes must be complete.
    for (const k of ["id", "created"]) if (typeof env[k] !== "string" || !env[k]) errs.push(`missing ${k}`);
    if (typeof env.from?.key !== "string") errs.push("missing from.key");
  }
  if (!env.to || typeof env.to.handle !== "string") errs.push("missing to.handle");
  if (env.intent && !INTENTS.includes(env.intent)) errs.push(`unknown intent ${env.intent}`);
  // Ids name files on the receiver's disk: strict shape only (no "../", no separators).
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  for (const k of ["id", "thread", "in_reply_to"]) if (env[k] != null && env[k] !== "" && !(typeof env[k] === "string" && ID.test(env[k]))) errs.push(`bad ${k}`);
  for (const h of [env.from?.handle, env.to?.handle]) if (typeof h === "string" && !/^@?[A-Za-z0-9._-]{1,64}$/.test(h)) errs.push("bad handle");
  for (const k of ["summary", "ask", "context"]) if (typeof env[k] === "string" && env[k].length > 20000) errs.push(`${k} too long`);
  for (const who of [env.from, env.to]) if (typeof who?.principal === "string" && (who.principal.length > 80 || /[\r\n]/.test(who.principal))) errs.push("bad principal name");
  return errs;
}

// ---------- armoring (text form that survives email / iMessage / Slack) ----------

function asciiJson(obj) {
  // Escape all non-ASCII so mail clients can't silently alter signed content.
  return JSON.stringify(obj, null, 2).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function armorCard(card) {
  return [
    `[Agent card · MPR/1] ${card.principal} — talk to my AI directly instead of relaying AI text through me.`,
    `Fingerprint: ${fingerprint(card.key)}`,
    BEGIN_CARD,
    asciiJson(card),
    END_CARD,
  ].join("\n");
}

function normalizeQuoted(block) {
  return block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(>\s?)+/, ""))
    .join("\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, " ");
}

function extractBlocks(text, begin) {
  // Tolerate what chat apps and other AIs do to the markers: "-----" turned into en/em dashes, case changes,
  // extra spaces, and ``` fences or "> " quoting around the JSON.
  const label = begin.replace(/^-+BEGIN\s+|-+$/g, "").replace(/\s+/g, "\\s+");
  const dash = "[-\u2010-\u2015\u2212]{2,}";
  const re = new RegExp(`${dash}\\s*BEGIN\\s+${label}\\s*${dash}([\\s\\S]*?)${dash}\\s*END\\s+${label}\\s*${dash}`, "gi");
  const out = [];
  for (const m of String(text).matchAll(re)) {
    const raw = normalizeQuoted(m[1]).replace(/^\s*```[a-z]*\s*$/gim, "").trim();
    try { out.push(JSON.parse(raw)); } catch (err) { out.push({ __parse_error: String(err.message) }); }
  }
  return out;
}

export function extractCards(text) {
  const found = extractBlocks(text, BEGIN_CARD);
  if (!found.length) {
    const t = normalizeQuoted(text).trim();
    if (t.startsWith("{") && t.includes('"mpr_card"')) {
      try { found.push(JSON.parse(t)); } catch {}
    }
  }
  return found;
}
