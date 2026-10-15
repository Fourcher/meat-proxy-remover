// Package version + pinned trust anchors (maintainer agent card, release signing key, update URLs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, "..", "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
export const TRUST = JSON.parse(fs.readFileSync(path.join(here, "..", "trust.json"), "utf8"));

export function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
