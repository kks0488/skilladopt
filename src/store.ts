import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Block } from "./blocks.js";
import type { Addition, Decision, Job } from "./job.js";
import type { SourceMeta } from "./source.js";
import { cacheHome, readJsonIf, sha256, UserError, writeFileAtomic, writeJson } from "./util.js";

export interface LockEntry {
  source: SourceMeta;
  license: string;
  targets: string[];
  output: Record<string, string>; // relative file path inside the skill dir -> sha256
  projectHash: string;
  adoptedAt: string;
  job: string;
  private: boolean;
}

export interface Lock {
  version: 1;
  skills: Record<string, LockEntry>;
}

export interface DecisionRecord {
  version: 1;
  name: string;
  source: SourceMeta;
  blocks: (Pick<Block, "id" | "file" | "kind" | "parent" | "hash" | "obligation"> & { decision: Decision })[];
  additions: Addition[];
  description: string;
}

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TARGET_RE = /^\.(agents|claude)\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const dataDir = (root: string) => join(root, ".skilladopt");
export const lockPath = (root: string) => join(dataDir(root), "lock.json");

export function readLock(root: string): Lock {
  return readJsonIf<Lock>(lockPath(root)) ?? { version: 1, skills: {} };
}

export function readDecisions(root: string, name: string): DecisionRecord | undefined {
  if (!NAME_RE.test(name)) return undefined;
  return readJsonIf<DecisionRecord>(join(dataDir(root), "decisions", `${name}.json`));
}

// ---------------------------------------------------------------- path safety

/**
 * Refuse to write through symbolic links or into anything that is not a plain directory.
 * Every component from the project root down to `rel` is checked with lstat.
 */
export function assertSafePath(root: string, rel: string): string {
  if (rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === "." || p === "")) throw new UserError(`Unsafe path: ${rel}`);
  const parts = rel.split("/");
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    let st;
    try { st = lstatSync(cur); } catch { break; } // does not exist yet: nothing below can exist either
    if (st.isSymbolicLink()) throw new UserError(`${parts.slice(0, i + 1).join("/")} is a symbolic link; skilladopt will not write through it.`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new UserError(`${parts.slice(0, i + 1).join("/")} is not a directory.`);
  }
  return join(root, rel);
}

export function isTarget(rel: string, name?: string): boolean {
  const m = TARGET_RE.exec(rel);
  return !!m && (name === undefined || m[2] === name);
}

export function hashDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[`${prefix}${name}`] = `symlink:${readlinkSync(full)}`;
      else if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = sha256(readFileSync(full));
    }
  };
  walk(dir, "");
  return out;
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Targets whose content differs from what was installed last time. */
export function localEdits(root: string, entry: LockEntry): string[] {
  return entry.targets.filter((t) => isTarget(t) && !sameMap(hashDir(join(root, t)), entry.output));
}

// ---------------------------------------------------------------- lock (mutex) and journal

interface Journal {
  version: 1;
  job: string;
  name: string;
  step: "staged" | "swapped" | "recorded";
  targets: { rel: string; existed: boolean }[];
}

// Transaction state lives outside the repository, in the user's cache, keyed by the project's real path.
// A repository can therefore never plant a journal, a backup or a lock that skilladopt would act on.
const txnDir = (root: string) => join(cacheHome(), "txn", sha256(realpathSync(root)).slice(0, 16));
const journalPath = (root: string) => join(txnDir(root), "journal.json");
const mutexPath = (root: string) => join(txnDir(root), "mutex");
const backupDir = (root: string, job: string) => join(txnDir(root), "backup", job);
const RECORD_ITEMS = (name: string) => ["lock.json", `decisions/${name}.json`, `upstream/${name}`, `approved/${name}`];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function acquire(root: string): void {
  mkdirSync(txnDir(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(mutexPath(root));
      writeFileSync(join(mutexPath(root), "owner.json"), JSON.stringify({ pid: process.pid }));
      return;
    } catch {
      const owner = readJsonIf<{ pid: number }>(join(mutexPath(root), "owner.json"));
      let busy = false;
      if (owner) busy = Number.isInteger(owner.pid) && owner.pid !== process.pid && alive(owner.pid);
      else {
        // Created but not yet stamped: another process is between mkdir and writing its pid.
        try { busy = Date.now() - statSync(mutexPath(root)).mtimeMs < 60_000; } catch { busy = false; }
      }
      if (busy) throw new UserError(`Another skilladopt apply${owner ? ` (pid ${owner.pid})` : ""} is running in this project.`);
      rmSync(mutexPath(root), { recursive: true, force: true }); // owner is gone: stale lock
    }
  }
  throw new UserError(`Could not lock ${mutexPath(root)}.`);
}

function release(root: string): void {
  rmSync(mutexPath(root), { recursive: true, force: true });
}

function readJournal(root: string): Journal | null {
  const path = journalPath(root);
  if (!existsSync(path)) return null;
  let j: Journal;
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch { throw new UserError(`${path} is not valid JSON. Inspect it and remove it by hand.`); }
  const ok =
    j && j.version === 1 && typeof j.job === "string" && /^[0-9a-f]{8}$/.test(j.job) &&
    typeof j.name === "string" && NAME_RE.test(j.name) && ["staged", "swapped", "recorded"].includes(j.step) &&
    Array.isArray(j.targets) && j.targets.every((t) => t && typeof t.rel === "string" && isTarget(t.rel, j.name) && typeof t.existed === "boolean");
  if (!ok) throw new UserError(`${path} does not look like a skilladopt journal. Nothing was touched; inspect it and remove it by hand.`);
  return j;
}

export function pendingJournal(root: string): string | null {
  return existsSync(journalPath(root)) ? journalPath(root) : null;
}

/** Undo (or finish) an interrupted apply. Only call while holding the lock. */
function rollback(root: string, j: Journal): string {
  if (j.step === "recorded") {
    for (const t of j.targets) rmSync(assertSafePath(root, `${t.rel}.skilladopt-old`), { recursive: true, force: true });
    rmSync(backupDir(root, j.job), { recursive: true, force: true });
    rmSync(journalPath(root), { force: true });
    return `finished interrupted apply of ${j.name}`;
  }
  for (const t of j.targets) {
    const target = assertSafePath(root, t.rel);
    const staged = assertSafePath(root, `${t.rel}.skilladopt-new`);
    const old = assertSafePath(root, `${t.rel}.skilladopt-old`);
    rmSync(staged, { recursive: true, force: true });
    if (existsSync(old)) {
      rmSync(target, { recursive: true, force: true });
      renameSync(old, target);
    } else if (!t.existed) {
      rmSync(target, { recursive: true, force: true }); // we created it
    }
  }
  const backup = backupDir(root, j.job);
  if (existsSync(backup)) {
    for (const item of RECORD_ITEMS(j.name)) {
      const live = assertSafePath(root, `.skilladopt/${item}`);
      rmSync(live, { recursive: true, force: true });
      if (existsSync(join(backup, item))) {
        mkdirSync(dirname(live), { recursive: true });
        cpSync(join(backup, item), live, { recursive: true });
      }
    }
    rmSync(backup, { recursive: true, force: true });
  }
  rmSync(journalPath(root), { force: true });
  return `rolled back interrupted apply of ${j.name}`;
}

/** `skilladopt recover`: explicit, locked recovery. */
export function recover(root: string): string | null {
  if (!existsSync(journalPath(root))) return null;
  acquire(root);
  try {
    const j = readJournal(root);
    return j ? rollback(root, j) : null;
  } finally {
    release(root);
  }
}

// ---------------------------------------------------------------- apply

export interface ApplyOptions {
  force: boolean;
  private: boolean;
  /** Test hook: throw after this step to exercise rollback. */
  failAfter?: "staged" | "swapped" | "records";
}

export function applyFiles(job: Job, files: Record<string, string>, opts: ApplyOptions): "applied" | "unchanged" {
  const root = job.root;
  const name = job.skill.name;
  if (!NAME_RE.test(name)) throw new UserError(`Invalid skill name ${name}`);
  for (const t of job.targets) if (!isTarget(t, name)) throw new UserError(`Invalid install target ${t}`);
  for (const p of Object.keys(files)) if (p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "." || s === "")) throw new UserError(`Invalid output path ${p}`);

  acquire(root);
  let journal: Journal | null = null;
  try {
    const stale = readJournal(root);
    if (stale) rollback(root, stale);

    const lock = readLock(root);
    const prev = lock.skills[name];
    const outputHashes: Record<string, string> = {};
    for (const [p, content] of Object.entries(files)) outputHashes[p] = sha256(content);
    if (prev && prev.job === job.id && localEdits(root, prev).length === 0 && sameMap(prev.output, outputHashes)) return "unchanged";
    if (!job.updating && prev && prev.source.id !== job.source.id && !opts.force) {
      throw new UserError(`A different skill named "${name}" is already adopted from ${prev.source.id}. Use another name or --force.`);
    }

    // Ownership is checked per target: only a folder we installed and nobody edited may be replaced.
    for (const t of job.targets) {
      const dir = assertSafePath(root, t);
      for (const suffix of [".skilladopt-new", ".skilladopt-old"]) {
        if (existsSync(assertSafePath(root, `${t}${suffix}`))) throw new UserError(`${t}${suffix} is left over from an earlier run. Check it, then remove it.`);
      }
      if (!existsSync(dir) || opts.force) continue;
      const managed = !!prev && prev.targets.includes(t);
      if (!managed) throw new UserError(`${t} already exists and is not managed by skilladopt. Move it away or use --force.`);
      if (!sameMap(hashDir(dir), prev!.output)) throw new UserError(`${t} was edited by hand since it was adopted. Keep your edits by copying them elsewhere, or overwrite with --force.`);
    }
    assertSafePath(root, ".skilladopt");
    for (const item of RECORD_ITEMS(name)) assertSafePath(root, `.skilladopt/${item}`);
    const plannedPrivate = [
      ...job.targets.flatMap((t) => Object.keys(files).map((p) => `${t}/${p}`)),
      ...job.files.map((f) => `.skilladopt/upstream/${name}/${f.path}`),
      ...Object.keys(files).map((p) => `.skilladopt/approved/${name}/${p}`),
      `.skilladopt/decisions/${name}.json`,
    ];
    if (opts.private) {
      // Exclude first, then ask git whether it really ignores every file we are about to write;
      // .gitignore negations can win over .git/info/exclude.
      const planned = [
        ...job.targets.flatMap((t) => Object.keys(files).map((p) => `${t}/${p}`)),
        ...job.files.map((f) => `.skilladopt/upstream/${name}/${f.path}`),
        ...Object.keys(files).map((p) => `.skilladopt/approved/${name}/${p}`),
        `.skilladopt/decisions/${name}.json`,
      ];
      assertNotTracked(root, privatePaths(job));
      excludeFromGit(root, privatePaths(job));
      assertIgnored(root, planned);
    }

    // Back up the record set so a failure restores records and installs together.
    const backup = backupDir(root, job.id);
    rmSync(backup, { recursive: true, force: true });
    for (const item of RECORD_ITEMS(name)) {
      const live = join(dataDir(root), item);
      if (existsSync(live)) {
        mkdirSync(dirname(join(backup, item)), { recursive: true });
        cpSync(live, join(backup, item), { recursive: true });
      }
    }
    mkdirSync(backup, { recursive: true });

    journal = { version: 1, job: job.id, name, step: "staged", targets: job.targets.map((rel) => ({ rel, existed: existsSync(join(root, rel)) })) };
    writeJson(journalPath(root), journal);
    for (const t of job.targets) {
      const staged = assertSafePath(root, `${t}.skilladopt-new`);
      for (const [p, content] of Object.entries(files)) {
        mkdirSync(dirname(join(staged, p)), { recursive: true });
        writeFileSync(join(staged, p), content);
      }
    }
    if (opts.failAfter === "staged") throw new Error("injected failure after staging");
    for (const t of job.targets) {
      const target = assertSafePath(root, t);
      if (existsSync(target)) renameSync(target, `${target}.skilladopt-old`);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(`${target}.skilladopt-new`, target);
    }
    journal = { ...journal, step: "swapped" };
    writeJson(journalPath(root), journal);
    if (opts.failAfter === "swapped") throw new Error("injected failure after swap");

    writeRecords(job, files, outputHashes, opts);
    if (opts.failAfter === "records") throw new Error("injected failure after records");
    // Re-check on the final state: the swap itself may have removed an ignore rule we relied on.
    if (opts.private) assertIgnored(root, plannedPrivate);
    journal = { ...journal, step: "recorded" };
    writeJson(journalPath(root), journal);
    rollback(root, journal); // "recorded": removes the old copies, the backup and the journal
    journal = null;
    return "applied";
  } catch (e) {
    const j = journal ?? (existsSync(journalPath(root)) ? readJournal(root) : null);
    if (j) rollback(root, j);
    throw e;
  } finally {
    release(root);
  }
}

function writeRecords(job: Job, files: Record<string, string>, outputHashes: Record<string, string>, opts: ApplyOptions): void {
  const root = job.root;
  const name = job.skill.name;
  const data = dataDir(root);

  const decision = new Map(job.decisions.map((d) => [d.blockId, d]));
  const record: DecisionRecord = {
    version: 1,
    name,
    source: job.source,
    description: job.skill.description,
    blocks: job.blocks.map((b) => ({ id: b.id, file: b.file, kind: b.kind, parent: b.parent, hash: b.hash, obligation: b.obligation, decision: decision.get(b.id)! })),
    additions: job.additions.filter((a) => a.status === "ok"),
  };
  writeJson(join(data, "decisions", `${name}.json`), record);

  // Upstream snapshot (U0) and approved copy (F0).
  const up = join(data, "upstream", name);
  rmSync(up, { recursive: true, force: true });
  for (const f of job.files) writeFileAtomic(join(up, f.path), f.content);
  const approved = join(data, "approved", name);
  rmSync(approved, { recursive: true, force: true });
  for (const [p, content] of Object.entries(files)) writeFileAtomic(join(approved, p), content);

  const lock = readLock(root);
  lock.skills[name] = {
    source: job.source,
    license: job.license?.spdx ?? "none",
    targets: job.targets,
    output: outputHashes,
    projectHash: job.projectHash,
    adoptedAt: new Date().toISOString().slice(0, 10),
    job: job.id,
    private: opts.private,
  };
  const sorted: Lock = { version: 1, skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) };
  writeJson(lockPath(root), sorted);
}

// ---------------------------------------------------------------- private mode

/** Everything that contains the adopted text: installs, snapshots and the decision record. */
function privatePaths(job: Job): string[] {
  const n = job.skill.name;
  return [...job.targets.map((t) => `${t}/`), `.skilladopt/upstream/${n}/`, `.skilladopt/approved/${n}/`, `.skilladopt/decisions/${n}.json`];
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function assertNotTracked(root: string, paths: string[]): void {
  const r = git(root, ["ls-files", "--", ...paths.map((p) => p.replace(/\/$/, ""))]);
  if (r.ok && r.out) throw new UserError(`Private mode cannot hide files git already tracks:\n  ${r.out.split("\n").slice(0, 5).join("\n  ")}\nUntrack them first (git rm --cached) or don't use --private.`);
}

function assertIgnored(root: string, paths: string[]): void {
  if (!git(root, ["rev-parse", "--git-dir"]).ok) return; // not a git repository
  // One call for all paths: check-ignore prints every path that IS ignored.
  const r = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, encoding: "utf8", input: paths.join("\n") + "\n" });
  const ignored = new Set((r.stdout ?? "").split("\n").filter(Boolean));
  const leaks = paths.filter((p) => !ignored.has(p));
  if (leaks.length) throw new UserError(`Private mode: git would not ignore ${leaks.slice(0, 3).join(", ")}${leaks.length > 3 ? " …" : ""} (a .gitignore rule re-includes it). Nothing was installed.`);
}

function excludeFromGit(root: string, paths: string[]): void {
  const r = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (!r.ok || !r.out) return; // not a git repository: nothing to exclude from
  const file = r.out.startsWith("/") ? r.out : join(root, r.out);
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const add = paths.map((p) => `/${p}`).filter((p) => !existing.split("\n").includes(p));
  if (add.length) appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}# skilladopt private (license not confirmed)\n${add.join("\n")}\n`);
}
