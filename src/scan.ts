/**
 * Static safety checks. These are tripwires, not proof of safety:
 * a clean scan means "nothing obvious", never "harmless".
 */

export type Level = "reject" | "review" | "info";

export interface Finding {
  level: Level;
  code: string;
  message: string;
}

const HIDDEN = /[​-‏⁠-⁤﻿‪-‮⁦-⁩­]|[\u{E0000}-\u{E007F}]/u;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const REMOTE_EXEC =
  /(curl|wget)[^\n|]*\|\s*(ba|z|da)?sh\b|\biex\s*\(|Invoke-Expression|base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh|\beval\s+"?\$\((curl|wget)/i;
const CREDENTIAL_ACCESS =
  /~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.npmrc|\.netrc|\bkeychain\b|\bprintenv\b|security find-generic-password|\.env\b(?!ironment)/i;
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const HTML_COMMENT = /<!--([\s\S]*?)-->/;
const URL = /https?:\/\/[^\s)>\]"'`]+/g;

/** Scan text that came from an upstream skill (untrusted input). */
export function scanInput(text: string): Finding[] {
  const out: Finding[] = [];
  if (HIDDEN.test(text)) out.push({ level: "reject", code: "hidden-unicode", message: "invisible or bidirectional unicode characters" });
  if (CONTROL.test(text)) out.push({ level: "reject", code: "control-chars", message: "terminal control characters" });
  if (REMOTE_EXEC.test(text)) out.push({ level: "review", code: "remote-exec", message: "downloads and runs remote code (curl | sh style)" });
  if (CREDENTIAL_ACCESS.test(text)) out.push({ level: "review", code: "credential-access", message: "mentions credential files or secret stores" });
  if (SECRET_VALUE.test(text)) out.push({ level: "review", code: "secret-value", message: "contains what looks like a secret token" });
  const comment = HTML_COMMENT.exec(text);
  if (comment && comment[1]!.trim()) out.push({ level: "review", code: "hidden-comment", message: "HTML comment (hidden when rendered)" });
  return out;
}

/** Scan text written by the worker agent. Stricter: new text must not smuggle anything in. */
export function scanOutput(text: string, sourceText: string): Finding[] {
  const out: Finding[] = [];
  if (HIDDEN.test(text)) out.push({ level: "reject", code: "hidden-unicode", message: "worker output contains invisible unicode" });
  if (CONTROL.test(text)) out.push({ level: "reject", code: "control-chars", message: "worker output contains control characters" });
  if (SECRET_VALUE.test(text)) out.push({ level: "reject", code: "secret-value", message: "worker output contains what looks like a secret" });
  if (REMOTE_EXEC.test(text) && !REMOTE_EXEC.test(sourceText)) out.push({ level: "reject", code: "remote-exec", message: "worker output adds a download-and-run command" });
  if (HTML_COMMENT.test(text)) out.push({ level: "reject", code: "hidden-comment", message: "worker output adds a hidden HTML comment" });
  if (CREDENTIAL_ACCESS.test(text) && !CREDENTIAL_ACCESS.test(sourceText)) out.push({ level: "review", code: "credential-access", message: "worker output mentions credential files" });
  const known = new Set(sourceText.match(URL) ?? []);
  const added = (text.match(URL) ?? []).filter((u) => !known.has(u));
  if (added.length) out.push({ level: "review", code: "new-url", message: `worker output adds URL(s): ${added.slice(0, 3).join(", ")}` });
  return out;
}

export function urlsIn(text: string): string[] {
  return [...new Set(text.match(URL) ?? [])];
}

export interface FileEntry {
  path: string; // relative to the skill directory, posix separators
  size: number;
  kind: "blob" | "symlink" | "submodule" | "other";
}

export const LIMITS = { fileBytes: 256 * 1024, totalBytes: 1024 * 1024, files: 100, pathLength: 200 };

const LICENSE_NAME = /^(LICENSE|LICENCE|NOTICE|COPYING)(\.(md|txt))?$/i;

export function classifyFile(path: string): "markdown" | "license" | "other" {
  const base = path.split("/").pop() ?? path;
  if (LICENSE_NAME.test(base)) return "license";
  if (/\.md$/i.test(base)) return "markdown";
  return "other";
}

/** Structural checks on the file list, before any content is read. */
export function checkEntries(entries: FileEntry[]): Finding[] {
  const out: Finding[] = [];
  let total = 0;
  const seen = new Map<string, string>();
  if (entries.length > LIMITS.files) out.push({ level: "reject", code: "too-many-files", message: `${entries.length} files (limit ${LIMITS.files})` });
  for (const e of entries) {
    const p = e.path;
    if (e.kind === "symlink") out.push({ level: "reject", code: "symlink", message: `symbolic link: ${p}` });
    if (e.kind === "submodule") out.push({ level: "reject", code: "submodule", message: `git submodule: ${p}` });
    if (e.kind === "other") out.push({ level: "reject", code: "special-file", message: `special file: ${p}` });
    if (p.startsWith("/") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "." || s === "") || CONTROL.test(p) || HIDDEN.test(p)) {
      out.push({ level: "reject", code: "bad-path", message: `unsafe path: ${JSON.stringify(p)}` });
    }
    if (p.length > LIMITS.pathLength) out.push({ level: "reject", code: "long-path", message: `path too long: ${p.slice(0, 60)}…` });
    if (e.size > LIMITS.fileBytes && classifyFile(p) !== "other") out.push({ level: "reject", code: "big-file", message: `${p} is ${e.size} bytes` });
    const key = p.normalize("NFC").toLowerCase();
    if (seen.has(key)) out.push({ level: "reject", code: "path-collision", message: `${p} collides with ${seen.get(key)}` });
    seen.set(key, p);
    if (classifyFile(p) !== "other") total += e.size;
  }
  if (total > LIMITS.totalBytes) out.push({ level: "reject", code: "too-big", message: `${total} bytes of text (limit ${LIMITS.totalBytes})` });
  return out;
}

/**
 * Find local file references in markdown: [x](path) links and `path/like.this` code spans.
 * Returns paths as written.
 */
export function localReferences(markdown: string): string[] {
  const refs = new Set<string>();
  for (const m of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!.split("#")[0]!;
    if (target && !/^[a-z]+:/i.test(target)) refs.add(target);
  }
  for (const m of markdown.matchAll(/`((?:\.{1,2}\/|[A-Za-z0-9_-]+\/)[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)) refs.add(m[1]!);
  return [...refs];
}
