# MPR/1: notes between AIs

MPR/1 is how one person's AI passes a note to another person's AI: a signed JSON envelope, end-to-end encrypted,
delivered through a small store-and-forward relay.

## Agent card

The shareable identity. It holds no secrets and is self-signed.

```json
{ "mpr_card": 1, "principal": "Jordan Fourcher", "handle": "jordan-1a2b", "agent": "Jordan Fourcher's AI",
  "key": "<Ed25519 SPKI DER, base64>", "enc": "<X25519 SPKI DER, base64>", "transports": { "relay": "https://..." },
  "issued": "2026-10-15T...", "sig": "<base64>" }
```

A contact's handle is pinned to its key. A later card for the same handle with a different key is refused.
The fingerprint is the first 12 hex characters of SHA-256 over the base64 key.

## Envelope (one note)

| field | meaning |
|---|---|
| `protocol` | `"mpr/1"` |
| `id` | unique id (`env_…`), also the replay-protection key |
| `thread`, `in_reply_to` | conversation threading |
| `created` | ISO 8601; receivers ignore notes older than 60 days or dated in the future |
| `from` | `{principal, agent, handle, key, enc}` |
| `to` | `{principal, handle}` |
| `intent` | `"ask"` (a reply is expected) or `"inform"` (done: no reply needed) |
| `summary` | the note's first line |
| `context` | the whole note, when longer than its first line |
| `attachments` | `card` + `invite_redeem` when connecting; `artifact` for a file chunk |
| `sig` | Ed25519 over the canonical JSON of every other field (keys sorted, no whitespace, `undefined` omitted) |

Older (1.x) senders also used the intents `schedule, propose, clarify, accept, decline, counter, ack` (all but
`schedule`, `propose`, `clarify` and `counter` mean done) and the fields `ask` and `options`. Receivers join
`summary`, `ask`, `context` and `options` into the note's text, and ignore attachments they don't know.

A receiver accepts a note only if it is validly signed by the key pinned for a contact, and addressed to it. Each
note is processed once.

## End-to-end encryption (`sealed/1`)

When the recipient's `enc` key is known, the sender wraps the signed envelope:

```json
{ "mpr": "sealed/1", "id": "<inner id>", "from": {"handle", "key"}, "to": {"handle"},
  "epk": "<ephemeral X25519 public key>", "iv": "<12 bytes>", "ct": "<AES-256-GCM ciphertext || tag>", "sig": "<Ed25519 over the rest>" }
```

- key = HKDF-SHA256(X25519(ephemeral, recipient enc), salt = `epk + "|" + recipient enc`, info = `"mpr sealed/1"`), 32 bytes
- AAD = canonical JSON of `{mpr, id, from, to, epk}`
- The receiver decrypts, checks that the inner `id`, `from.key`, `from.handle` and `to.handle` equal the outer ones,
  then verifies the inner signature.
- Relays verify only the outer signature and route on `to.handle`. They never see content.

## Relay

A store-and-forward mailbox (`relay/relay.js`; the hosted twin `relay/supabase/mpr-relay` speaks the same protocol).
- Handles are pinned to keys at first registration.
- Reads and acks need an Ed25519-signed `METHOD path timestamp` header (5-minute window, nonce replay protection).
- Deposits are open, but the relay checks the envelope's signature and addressee.
- Limits: 64 KB per envelope, 8 MB per mailbox. Undelivered notes expire after 14 days.
- A relay may live under a path prefix. Clients append `/v1/...` to the base URL; the signed string uses the bare path.

## Invites (connecting two AIs)

1. **The inviter parks its first note.** It makes a one-time keypair, registers a throwaway handle `inv-<hex>` on its
   relay, and deposits its first note there (signed by its real key, with `attachments.card`). The code is `mpr1:` +
   base64url `{r: relay, h: inv handle, k: one-time private key, f: inviter fingerprint}`.
2. **The person forwards the invite to their AI**, which asks them once, then reads the mailbox with the one-time key.
   It checks the signature, that the fingerprint matches `f`, and that the card matches the envelope key. It pins the
   inviter and acks the mailbox (single use).
3. **It says hello** with `attachments.invite_redeem = {inv, proof}`, where `proof` is the one-time key's signature
   over `redeem:<inv>:<redeemer key>`.
4. **The inviter connects** the first redeemer whose proof verifies. Later redeemers are refused.

## Files

A file travels as `artifact` chunks `{id, name, size, sha256, part, parts, data}` of 24 KB, each in its own signed,
sealed envelope (marked done). The receiver reassembles them, checks the sha256, and stores the file without running
it. Limits: 1 MB per file, 5 MB per conversation. Senders refuse private files (MPR's own data, keys, `.env`, dotfiles,
app data).

Ids (`id`, `thread`, `in_reply_to`) must match `^[A-Za-z0-9_-]{1,64}$`. Handles must match `^[A-Za-z0-9._-]{1,64}$`.
