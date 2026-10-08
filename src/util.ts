import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const VERSION = "0.1.5";

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

export function shortHash(s: string | Buffer): string {
  return sha256(s).slice(0, 12);
}

export function randomId(): string {
  return randomBytes(4).toString("hex");
}

/** JSON.stringify with sorted object keys, so hashes are stable. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomId()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonIf<T>(path: string): T | undefined {
  return existsSync(path) ? readJson<T>(path) : undefined;
}

export function cacheHome(): string {
  if (process.env.SKILLADOPT_HOME) return process.env.SKILLADOPT_HOME;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "skilladopt");
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

/** Make untrusted text safe to print in a terminal (no escape sequences). */
export function safePrint(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function oneLine(s: string, max = 70): string {
  const flat = safePrint(s.replace(/\s+/g, " ").trim());
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export class UserError extends Error {}
