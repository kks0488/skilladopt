import { parseFrontmatter, splitBlocks, type Block } from "./blocks.js";
import { lookup, type Project } from "./facts.js";
import type { Evidence } from "./job.js";
import type { FetchedSource } from "./source.js";
import { localEdits, readDecisions, readLock, type DecisionRecord } from "./store.js";

export interface Stale {
  where: string; // block id or addition id
  action: string;
  reason: string;
  why: string; // human explanation of what changed
}

export interface SkillImpact {
  name: string;
  total: number; // decisions recorded
  stale: Stale[];
  localEdits: string[];
  upstream?: { from: string; to: string; changed: number; added: number; removed: number; affected: Stale[] } | { error: string };
  missingRecord?: boolean;
  /** Instruction lines that did not exist when the skill was adopted. Kept paragraphs were never checked against them. */
  newRules?: string[];
}

/** Re-check one piece of recorded evidence against the project as it is now. */
export function evidenceDrift(project: Project, ev: Evidence): string | null {
  const now = lookup(project, ev.ref);
  if (ev.ref.startsWith("agents:")) {
    if (now.state === "present" && now.hash === ev.hash) return null;
    const moved = project.agents.find((a) => a.hash === ev.hash);
    if (moved) return null; // same line, different position: still holds
    return now.state === "present" ? `${ev.ref} now says "${(now.value ?? "").slice(0, 60)}"` : `${ev.ref} was removed`;
  }
  if (now.state !== ev.state) return `${ev.ref}: ${ev.state} → ${now.state}`;
  if (ev.hash && now.hash !== ev.hash) return `${ev.ref} changed: \`${(ev.value ?? "").slice(0, 50)}\` → \`${(now.value ?? "").slice(0, 50)}\``;
  return null;
}

function staleFor(project: Project, rec: DecisionRecord): Stale[] {
  const out: Stale[] = [];
  for (const b of rec.blocks) {
    const d = b.decision;
    const whys = d.evidence.map((e) => evidenceDrift(project, e)).filter((x): x is string => !!x);
    if (whys.length) out.push({ where: b.id, action: d.action, reason: d.reason, why: whys.join("; ") });
  }
  for (const a of rec.additions) {
    const whys = a.evidence.map((e) => evidenceDrift(project, e)).filter((x): x is string => !!x);
    if (whys.length) out.push({ where: a.id, action: "add", reason: "project-note", why: whys.join("; ") });
  }
  return out;
}

export function blocksOf(files: { path: string; content: string }[]): Block[] {
  const counter = { n: 0 };
  const md = files.filter((f) => /\.md$/i.test(f.path) && !/^(LICENSE|LICENCE|NOTICE|COPYING)/i.test(f.path.split("/").pop()!));
  md.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  return md.flatMap((f) => splitBlocks(f.path, parseFrontmatter(f.content).body, counter));
}

/**
 * Which recorded decisions does an upstream change touch?
 * A decision is affected if its block changed or disappeared, or if any enclosing heading changed.
 */
export function upstreamDiff(rec: DecisionRecord, next: Block[]): { changed: number; added: number; removed: number; affected: Stale[] } {
  const oldById = new Map(rec.blocks.map((b) => [b.id, b]));
  const newById = new Map(next.map((b) => [b.id, b]));
  const chain = (id: string | null, byId: Map<string, { parent: string | null; hash: string }>): string => {
    const out: string[] = [];
    for (let p = id; p; p = byId.get(p)?.parent ?? null) out.push(byId.get(p)?.hash ?? "?");
    return out.join("/");
  };
  // Match blocks by file + text hash, one-to-one in order, so duplicates are counted.
  const pool = new Map<string, Block[]>();
  for (const b of next) {
    const k = `${b.file}\n${b.hash}`;
    pool.set(k, [...(pool.get(k) ?? []), b]);
  }
  const matched = new Map<string, Block>(); // old id -> new block
  for (const b of rec.blocks) {
    const list = pool.get(`${b.file}\n${b.hash}`);
    if (list?.length) matched.set(b.id, list.shift()!);
  }
  const gone = new Set(rec.blocks.filter((b) => !matched.has(b.id)).map((b) => b.id));
  const affected: Stale[] = [];
  for (const b of rec.blocks) {
    let why = gone.has(b.id) ? "changed or removed upstream" : "";
    if (!why && chain(b.parent, oldById) !== chain(matched.get(b.id)!.parent, newById)) why = "moved to a different section upstream";
    for (let p = b.parent; !why && p; p = oldById.get(p)?.parent ?? null) {
      if (gone.has(p)) why = `its section heading ${p} changed upstream`;
    }
    if (why) affected.push({ where: b.id, action: b.decision.action, reason: b.decision.reason, why });
  }
  const added = [...pool.values()].reduce((n, l) => n + l.length, 0);
  return { changed: Math.min(gone.size, added), added: Math.max(0, added - gone.size), removed: Math.max(0, gone.size - added), affected };
}

export function projectImpact(project: Project, upstream?: Map<string, FetchedSource | Error>): SkillImpact[] {
  const lock = readLock(project.root);
  const out: SkillImpact[] = [];
  for (const [name, entry] of Object.entries(lock.skills)) {
    const rec = readDecisions(project.root, name);
    if (!rec) { out.push({ name, total: 0, stale: [], localEdits: localEdits(project.root, entry), missingRecord: true }); continue; }
    const item: SkillImpact = { name, total: rec.blocks.length, stale: staleFor(project, rec), localEdits: localEdits(project.root, entry) };
    if (entry.agents) {
      const known = new Set(entry.agents);
      const fresh = project.agents.filter((a) => !known.has(a.hash)).map((a) => `${a.ref} "${a.text.trim().slice(0, 70)}"`);
      if (fresh.length) item.newRules = fresh;
    }
    const up = upstream?.get(name);
    if (up instanceof Error) item.upstream = { error: up.message };
    else if (up && up.meta.commit && up.meta.commit !== entry.source.commit) {
      item.upstream = { from: entry.source.commit ?? "?", to: up.meta.commit, ...upstreamDiff(rec, blocksOf(up.files)) };
    }
    out.push(item);
  }
  return out;
}
