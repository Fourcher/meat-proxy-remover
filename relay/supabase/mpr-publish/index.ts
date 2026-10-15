// mpr-publish: lets the maintainer's release key publish packages to the public mpr-dist bucket,
// with no database credentials on any machine. Deployed with verify_jwt=false (own Ed25519 auth).
//
//   POST /mpr-publish?name=<file>   body = file bytes
//   headers: x-mpr-time (ms epoch), x-mpr-sig = Ed25519 sig over "publish:<name>:<sha256 hex of body>:<time>"
//
// Rules: versioned packages (meat-proxy-remover-X.Y.Z.tgz|.mcpb) are create-only; latest.json, install.md, install.sh and install.ps1 may be replaced
// (clients independently verify its release signature and refuse version downgrades).
// Primary release key + offline recovery key (same list as src/trust.json release_pubkeys).
const RELEASE_PUBKEYS = ["MCowBQYDK2VwAyEAgTEbY1rikaPUBmw6WgLBL3L5cEnYiZZLOYXGYha7wYA=", "MCowBQYDK2VwAyEAcKSx+tNKT1ucWqrNk0H722RTpA9zsjS8xnrCqYNzxvM="];
const BUCKET = "mpr-dist";
const MAX = 45 * 1024 * 1024;
const SKEW_MS = 5 * 60 * 1000;
const VERSIONED = /^meat-proxy-remover-\d+\.\d+\.\d+\.(tgz|mcpb)$/;

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const json = (code: number, obj: unknown) => new Response(JSON.stringify(obj), { status: code, headers: { "content-type": "application/json" } });

async function verify(str: string, sigB64: string): Promise<boolean> {
  for (const pub of RELEASE_PUBKEYS) {
    try {
      const key = await crypto.subtle.importKey("spki", b64(pub), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify("Ed25519", key, b64(sigB64), new TextEncoder().encode(str))) return true;
    } catch { /* try the next key */ }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const name = new URL(req.url).searchParams.get("name") || "";
  const MUTABLE = ["latest.json", "install.md", "install.sh", "install.ps1", "meat-proxy-remover.mcpb"];
  if (!(VERSIONED.test(name) || MUTABLE.includes(name))) return json(400, { error: "name not allowed" });
  const ts = Number(req.headers.get("x-mpr-time"));
  if (!ts || Math.abs(Date.now() - ts) > SKEW_MS) return json(401, { error: "stale or missing timestamp" });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0 || body.length > MAX) return json(413, { error: "bad size" });
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body))).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!(await verify(`publish:${name}:${hash}:${ts}`, req.headers.get("x-mpr-sig") || ""))) return json(401, { error: "bad signature" });

  const url = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${name}`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const type = name.endsWith(".json") ? "application/json" : name.endsWith(".md") ? "text/markdown; charset=utf-8" : (name.endsWith(".sh") || name.endsWith(".ps1")) ? "text/plain; charset=utf-8" : name.endsWith(".tgz") ? "application/gzip" : "application/zip";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`, apikey: key, "content-type": type,
      "x-upsert": MUTABLE.includes(name) ? "true" : "false",
      "cache-control": MUTABLE.includes(name) ? "max-age=30" : "max-age=31536000",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) return json(res.status === 409 || /exists/i.test(text) ? 409 : 502, { error: "storage refused", detail: text.slice(0, 300) });
  return json(200, { ok: true, name, sha256: hash });
});
