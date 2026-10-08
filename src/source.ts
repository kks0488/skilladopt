import { lstatSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { checkEntries, classifyFile, LIMITS, localReferences, scanInput, type FileEntry, type Finding } from "./scan.js";
import { UserError, sha256 } from "./util.js";

export type SourceSpec =
  | { type: "github"; owner: string; repo: string; ref?: string; path: string; name?: string }
  | { type: "local"; dir: string };

export interface SourceMeta {
  type: "github" | "local";
  id: string; // github:owner/repo/path or local:/abs/dir
  owner?: string;
  repo?: string;
  path?: string;
  ref?: string;
  commit?: string;
  url?: string;
  dir?: string;
  /** Repository paths of shared docs bundled into the skill because it links to them (see bundleReferences). */
  bundled?: string[];
}

export interface FetchedSource {
  meta: SourceMeta;
  files: { path: string; content: string; hash: string }[]; // markdown + license files
  excluded: string[]; // non-text files that were not downloaded
  license: { spdx: string; text: string; path: string } | null;
  findings: Finding[];
}

const NAME = /^[A-Za-z0-9_.-]+$/;

export function parseSource(spec: string): SourceSpec {
  const s = spec.trim();
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || s.startsWith("~") || s === ".") {
    const dir = resolve(s.startsWith("~") ? join(homedir(), s.slice(1)) : s);
    return { type: "local", dir };
  }
  let m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(s);
  if (m) {
    const [, owner, repoRaw, kind, ref, rest] = m;
    const repo = repoRaw!.replace(/\.git$/, "");
    let path = (rest ?? "").replace(/\/$/, "");
    if (kind === "blob") path = path.split("/").slice(0, -1).join("/");
    return validateGithub({ type: "github", owner: owner!, repo, ref, path });
  }
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([^#]*))?(?:#(.+))?$/.exec(s);
  if (m) {
    return validateGithub({ type: "github", owner: m[1]!, repo: m[2]!, path: (m[3] ?? "").replace(/\/$/, ""), ref: m[4] });
  }
  throw new UserError(`Can't read source "${spec}". Use a GitHub URL, owner/repo/path, or a local ./path.`);
}

function validateGithub(src: { type: "github"; owner: string; repo: string; ref?: string; path: string }): SourceSpec {
  if (!NAME.test(src.owner) || !NAME.test(src.repo)) throw new UserError("Invalid GitHub owner/repo name.");
  if (src.ref !== undefined && !/^[A-Za-z0-9_.\-/]+$/.test(src.ref)) throw new UserError("Invalid git ref.");
  if (src.path.split("/").some((p) => p === ".." || p === ".")) throw new UserError("Invalid path in source.");
  return src;
}

// ---------------------------------------------------------------- GitHub

const API = "https://api.github.com";

async function gh(path: string): Promise<any> {
  let url = `${API}${path}`;
  for (let hop = 0; hop < 3; hop++) {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "skilladopt",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next || new URL(next).host !== "api.github.com" || new URL(next).protocol !== "https:") {
        throw new UserError(`GitHub redirected to an unexpected location: ${next}`);
      }
      url = next;
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      throw new UserError("GitHub API rate limit reached. Set GITHUB_TOKEN (for example: export GITHUB_TOKEN=$(gh auth token)) and retry.");
    }
    if (!res.ok) throw new UserError(`GitHub API error ${res.status} for ${path}`);
    return res.json();
  }
  throw new UserError("Too many redirects from GitHub.");
}

export async function fetchGithub(src: Extract<SourceSpec, { type: "github" }>): Promise<FetchedSource> {
  const repoPath = `/repos/${src.owner}/${src.repo}`;
  let ref = src.ref;
  if (!ref) {
    const info = await gh(repoPath);
    if (!info) throw new UserError(`Repository ${src.owner}/${src.repo} not found (or private without GITHUB_TOKEN).`);
    ref = String(info.default_branch);
  }
  const commitInfo = await gh(`${repoPath}/commits/${encodeURIComponent(ref)}`);
  if (!commitInfo) throw new UserError(`Ref "${ref}" not found in ${src.owner}/${src.repo}.`);
  const commit = String(commitInfo.sha);
  const tree = await gh(`${repoPath}/git/trees/${commit}?recursive=1`);
  if (!tree) throw new UserError("Could not read the repository tree.");
  if (tree.truncated) throw new UserError("Repository tree is too large for the GitHub API; point at the skill directory with a smaller repo or a local checkout.");
  const all = tree.tree as { path: string; mode: string; type: string; size?: number; sha: string }[];

  let base = src.path;
  if (src.name || !all.some((e) => e.type === "blob" && e.path === (base ? `${base}/SKILL.md` : "SKILL.md"))) {
    base = pickSkill(all.filter((e) => e.type === "blob").map((e) => e.path), base, src.name, `${src.owner}/${src.repo}`);
  }
  const prefix = base ? `${base}/` : "";
  const inDir = all.filter((e) => e.path.startsWith(prefix) && e.type !== "tree");
  const entries: FileEntry[] = inDir.map((e) => ({
    path: e.path.slice(prefix.length),
    size: e.size ?? 0,
    kind: e.mode === "120000" ? "symlink" : e.type === "commit" || e.mode === "160000" ? "submodule" : e.type === "blob" ? "blob" : "other",
  }));
  const findings = checkEntries(entries);
  if (findings.some((f) => f.level === "reject")) return reject(findings, { type: "github", id: "" });

  const files: FetchedSource["files"] = [];
  const excluded: string[] = [];
  for (const e of inDir) {
    const rel = e.path.slice(prefix.length);
    if (classifyFile(rel) === "other") { excluded.push(rel); continue; }
    const blob = await gh(`${repoPath}/git/blobs/${e.sha}`);
    const content = Buffer.from(String(blob.content), "base64").toString("utf8");
    files.push({ path: rel, content, hash: sha256(content).slice(0, 16) });
  }

  // License: the skill folder's own top-level LICENSE first, else the repository root's,
  // both read from the same pinned commit as the skill itself.
  const bundled = await bundleReferences(files, base, async (repoPath) => {
    const e = all.find((x) => x.path === repoPath && x.type === "blob" && x.mode !== "120000" && (x.size ?? 0) <= LIMITS.fileBytes);
    if (!e) return null;
    const blob = await gh(`/repos/${src.owner}/${src.repo}/git/blobs/${e.sha}`);
    return Buffer.from(String(blob.content), "base64").toString("utf8");
  });

  let license = detectLicenseFromFiles(files);
  if (!license) {
    // Nearest LICENSE from the skill folder up to the repository root (plugins often carry their own).
    for (let dir = posix.dirname(base || "."); !license; dir = posix.dirname(dir)) {
      const at = dir === "." ? "" : `${dir}/`;
      const lic = all.find((e) => e.type === "blob" && e.mode !== "120000" && e.path.startsWith(at) && !e.path.slice(at.length).includes("/") && LICENSE_FILE.test(e.path.slice(at.length)) && (e.size ?? 0) <= LIMITS.fileBytes);
      if (lic) {
        const blob = await gh(`${repoPath}/git/blobs/${lic.sha}`);
        license = licenseFrom(Buffer.from(String(blob.content), "base64").toString("utf8"), lic.path);
      }
      if (dir === ".") break;
    }
  }
  const meta: SourceMeta = {
    type: "github",
    id: `github:${src.owner}/${src.repo}${base ? `/${base}` : ""}`,
    owner: src.owner,
    repo: src.repo,
    path: base,
    ref,
    commit,
    url: `https://github.com/${src.owner}/${src.repo}/tree/${commit}${base ? `/${base}` : ""}`,
    ...(bundled.length ? { bundled } : {}),
  };
  return { meta, files, excluded, license, findings };
}

/** Latest commit that touched the skill directory, without downloading it. */
export async function latestCommit(meta: SourceMeta): Promise<string | null> {
  if (meta.type !== "github") return null;
  const q = meta.path ? `?path=${encodeURIComponent(meta.path)}&sha=${encodeURIComponent(meta.ref ?? "")}&per_page=1` : `?sha=${encodeURIComponent(meta.ref ?? "")}&per_page=1`;
  const list = await gh(`/repos/${meta.owner}/${meta.repo}/commits${q}`);
  return Array.isArray(list) && list[0] ? String(list[0].sha) : null;
}

// ---------------------------------------------------------------- local

export async function fetchLocal(dir: string): Promise<FetchedSource> {
  if (!existsSync(join(dir, "SKILL.md"))) throw new UserError(`No SKILL.md in ${dir}`);
  const entries: FileEntry[] = [];
  const walk = (d: string) => {
    if (entries.length > LIMITS.files) return;
    for (const name of readdirSync(d).sort()) {
      if (entries.length > LIMITS.files) return;
      const full = join(d, name);
      const st = lstatSync(full);
      const rel = relative(dir, full).split("\\").join("/");
      if (st.isSymbolicLink()) entries.push({ path: rel, size: 0, kind: "symlink" });
      else if (st.isDirectory()) { if (name !== ".git") walk(full); }
      else if (st.isFile()) entries.push({ path: rel, size: st.size, kind: "blob" });
      else entries.push({ path: rel, size: 0, kind: "other" });
    }
  };
  walk(dir);
  const findings = checkEntries(entries);
  if (findings.some((f) => f.level === "reject")) return reject(findings, { type: "local", id: `local:${dir}` });
  const files: FetchedSource["files"] = [];
  const excluded: string[] = [];
  for (const e of entries) {
    if (classifyFile(e.path) === "other") { excluded.push(e.path); continue; }
    const content = readFileSync(join(dir, e.path), "utf8");
    files.push({ path: e.path, content, hash: sha256(content).slice(0, 16) });
  }
  // Shared docs outside the folder are only bundled when a git repository bounds them.
  const root = gitRoot(dir);
  const bundled = root
    ? await bundleReferences(files, relative(root, dir).split("\\").join("/"), async (repoPath) => {
        const full = resolve(root, repoPath);
        if (!full.startsWith(root + sep)) return null;
        let cur = root;
        for (const part of relative(root, full).split(sep)) {
          cur = join(cur, part);
          try { if (lstatSync(cur).isSymbolicLink()) return null; } catch { return null; }
        }
        return lstatSync(full).isFile() && lstatSync(full).size <= LIMITS.fileBytes ? readFileSync(full, "utf8") : null;
      })
    : [];
  const content = files.map((f) => `${f.path}\n${f.hash}`).join("\n");
  return {
    meta: { type: "local", id: `local:${dir}`, dir, commit: `local-${sha256(content).slice(0, 12)}`, ...(bundled.length ? { bundled } : {}) },
    files,
    excluded,
    license: detectLicenseFromFiles(files) ?? (root ? nearestLicense(dirname(resolve(dir)), root) : null),
    findings,
  };
}

function nearestLicense(from: string, root: string): FetchedSource["license"] {
  for (let d = from; d.startsWith(root); d = dirname(d)) {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (LICENSE_FILE.test(name) && lstatSync(full).isFile() && lstatSync(full).size <= LIMITS.fileBytes) return licenseFrom(readFileSync(full, "utf8"), relative(root, full));
    }
    if (d === root) break;
  }
  return null;
}

/**
 * Choose the skill directory in a repository. `name` picks a skill by its folder name; copies mirrored
 * into dot-folders (.claude/, .agents/ …) lose to the plain one. Several different skills is an error
 * that lists the short command for each.
 */
export function pickSkill(paths: string[], base: string, name: string | undefined, repo: string): string {
  const skillName = (d: string) => d.split("/").pop() || repo.split("/").pop()!;
  const rank = (d: string) => (d.split("/").some((p) => p.startsWith(".")) ? 1000 : 0) + d.length;
  let candidates = paths
    .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
    .map((p) => p.replace(/\/?SKILL\.md$/, ""))
    .filter((d) => !base || d === base || d.startsWith(`${base}/`))
    .sort((a, b) => rank(a) - rank(b));
  if (name) candidates = candidates.filter((d) => skillName(d) === name).slice(0, 1);
  const names = [...new Set(candidates.map(skillName))];
  if (names.length === 1) return candidates[0]!;
  if (!candidates.length) throw new UserError(`No skill${name ? ` named "${name}"` : ""} found in ${repo}${base ? `/${base}` : ""}`);
  const list = names.slice(0, 30).map((n) => `  skilladopt add ${repo} ${n}`).join("\n");
  throw new UserError(`This repository has ${names.length} skills. Pick one:\n${list}${names.length > 30 ? "\n  …" : ""}`);
}

function gitRoot(dir: string): string | null {
  for (let d = resolve(dir), i = 0; i < 6; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * Bundle shared Markdown docs that a skill links to outside its own folder (e.g. `../../references/x.md`),
 * one level deep, from the same repository only. They are stored under `bundled/<repo path>` and the
 * links in the skill are rewritten to point there. Anything else outside the folder stays a refusal.
 */
async function bundleReferences(files: FetchedSource["files"], base: string, read: (repoPath: string) => Promise<string | null>): Promise<string[]> {
  const bundled: string[] = [];
  for (const f of files.filter((x) => classifyFile(x.path) === "markdown")) {
    let text = f.content;
    const refs = localReferences(f.content).sort((a, b) => b.length - a.length);
    for (const ref of refs) {
      const dir = posix.dirname(f.path);
      if (!posix.normalize(posix.join(dir, ref)).startsWith("../")) continue;
      const repoPath = posix.normalize(posix.join(base, dir, ref));
      if (repoPath.startsWith("../") || repoPath.startsWith("/") || !/\.md$/i.test(repoPath)) continue;
      if (/(^|\/)SKILL\.md$/i.test(repoPath)) continue; // another skill: adopt it on its own
      const to = `bundled/${repoPath}`;
      if (!files.some((x) => x.path === to)) {
        const content = await read(repoPath);
        if (content === null) continue;
        files.push({ path: to, content, hash: sha256(content).slice(0, 16) });
        bundled.push(repoPath);
      }
      text = text.split(ref).join(posix.relative(dir, to));
    }
    if (text !== f.content) { f.content = text; f.hash = sha256(text).slice(0, 16); }
  }
  if (files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > LIMITS.totalBytes) throw new UserError("Skill plus bundled references exceed the size limit.");
  return bundled;
}

function reject(findings: Finding[], meta: SourceMeta): FetchedSource {
  return { meta, files: [], excluded: [], license: null, findings };
}

const LICENSE_FILE = /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i;

/** Only a LICENSE at the top of the skill folder speaks for the whole skill. */
function detectLicenseFromFiles(files: FetchedSource["files"]): FetchedSource["license"] {
  const f = files.find((x) => !x.path.includes("/") && LICENSE_FILE.test(x.path));
  return f ? licenseFrom(f.content, f.path) : null;
}

function licenseFrom(text: string, path: string): NonNullable<FetchedSource["license"]> {
  // A license text with anything suspicious in it (hidden characters, tokens, hidden comments…)
  // is not trusted as a license and is never copied.
  const suspicious = scanInput(text).length > 0;
  return { spdx: suspicious ? "UNKNOWN" : detectSpdx(text), text: suspicious ? "" : text, path };
}

/** Conservative: a license is only recognised when its distinctive clauses are all present. */
export function detectSpdx(text: string): string {
  if (/Permission is hereby granted, free of charge/i.test(text) && /THE SOFTWARE IS PROVIDED "AS IS"/i.test(text) && /above copyright notice and this permission notice shall be included/i.test(text)) return "MIT";
  if (/Apache License/i.test(text) && /Version 2\.0/i.test(text) && /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/i.test(text)) return "Apache-2.0";
  if (/Redistribution and use in source and binary forms/i.test(text) && /Redistributions of source code must retain the above copyright notice/i.test(text) && /THIS SOFTWARE IS PROVIDED BY/i.test(text)) {
    return /Neither the name/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(text) && /THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES/i.test(text)) return "ISC";
  if (/Mozilla Public License,? v(ersion)? 2\.0/i.test(text) && /Covered Software/i.test(text)) return "MPL-2.0";
  if (/This is free and unencumbered software released into the public domain/i.test(text) && /unlicense\.org/i.test(text)) return "Unlicense";
  if (/CC0 1\.0 Universal/i.test(text) && /Statement of Purpose/i.test(text)) return "CC0-1.0";
  if (/Attribution 4\.0 International/i.test(text) && /Creative Commons Corporation/i.test(text)) return "CC-BY-4.0";
  return "UNKNOWN";
}

/** Licenses we know how to honour when redistributing a modified copy inside a repo. */
export const PERMISSIVE = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0", "CC-BY-4.0", "0BSD", "MIT-0"]);
