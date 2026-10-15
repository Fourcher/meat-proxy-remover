// Ed25519 identity + canonical JSON signing. Node built-ins only.
import crypto from "node:crypto";

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

function pub(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}
function priv(b64) {
  return crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}

export function signString(str, privateKeyB64) {
  return crypto.sign(null, Buffer.from(str), priv(privateKeyB64)).toString("base64");
}

export function verifyString(str, sigB64, publicKeyB64) {
  try {
    return crypto.verify(null, Buffer.from(str), pub(publicKeyB64), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/** Sign an object: signature covers canonical JSON of everything except `sig`. */
export function signObject(obj, privateKeyB64) {
  const { sig, ...body } = obj;
  return { ...body, sig: signString(canonical(body), privateKeyB64) };
}

export function verifyObject(obj, publicKeyB64) {
  if (!obj || typeof obj.sig !== "string") return false;
  const { sig, ...body } = obj;
  return verifyString(canonical(body), sig, publicKeyB64);
}

/** Short human-comparable fingerprint of a public key, e.g. "3F9A-17C2-88D0". */
export function fingerprint(publicKeyB64) {
  const h = crypto.createHash("sha256").update(publicKeyB64).digest("hex").toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

// ---------------- end-to-end encryption (sealed/1) ----------------
// X25519 (ephemeral sender key) → HKDF-SHA256 → AES-256-GCM. The relay sees only routing (from/to handle, id).
// The sealed wrapper is Ed25519-signed by the sender so relays keep their "signed envelopes only" rule.

export function generateEncKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    encPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    encPrivateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

function sealKey(shared, epk, recipient) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(epk + "|" + recipient), Buffer.from("mpr sealed/1"), 32));
}

/** Encrypt a (signed) envelope for one recipient. */
export function seal(env, recipientEncB64, signPrivB64) {
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const recipient = crypto.createPublicKey({ key: Buffer.from(recipientEncB64, "base64"), format: "der", type: "spki" });
  const key = sealKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), epk, recipientEncB64);
  const outer = { mpr: "sealed/1", id: env.id, from: { handle: env.from.handle, key: env.from.key }, to: { handle: env.to.handle }, epk };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(canonical(outer)));
  const ct = Buffer.concat([c.update(JSON.stringify(env)), c.final(), c.getAuthTag()]);
  return signObject({ ...outer, iv: iv.toString("base64"), ct: ct.toString("base64") }, signPrivB64);
}

export const isSealed = (x) => !!x && x.mpr === "sealed/1";

/** Decrypt a sealed envelope with our X25519 private key. Throws if it was tampered with or isn't for us. */
export function unseal(sealed, encPrivB64, encPubB64) {
  const { iv, ct, sig, ...outer } = sealed;
  const priv = crypto.createPrivateKey({ key: Buffer.from(encPrivB64, "base64"), format: "der", type: "pkcs8" });
  const epk = crypto.createPublicKey({ key: Buffer.from(outer.epk, "base64"), format: "der", type: "spki" });
  const key = sealKey(crypto.diffieHellman({ privateKey: priv, publicKey: epk }), outer.epk, encPubB64);
  const buf = Buffer.from(ct, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(canonical(outer)));
  d.setAuthTag(buf.subarray(buf.length - 16));
  const env = JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8"));
  // The inside must match the outside (no swapping a sealed body under someone else's routing).
  if (env.id !== outer.id || env.from?.key !== outer.from.key || env.from?.handle !== outer.from.handle || env.to?.handle !== outer.to.handle)
    throw new Error("sealed envelope routing doesn't match its contents");
  return env;
}
