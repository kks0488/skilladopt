import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Block } from "./blocks.js";
import type { FactState } from "./facts.js";
import type { Finding } from "./scan.js";
import type { SourceMeta } from "./source.js";
import { cacheHome, readJson, writeJson, UserError } from "./util.js";

export type Action = "keep" | "bind" | "drop" | "rewrite" | "review";
export const REASONS = [
  "universal",
  "project-fit",
  "stack-mismatch",
  "tool-substitution",
  "duplicate-of-agents-md",
  "conflict-with-agents-md",
  "duplicate-of-skill",
  "forbidden-by-policy",
  "out-of-scope",
  "needs-human",
] as const;
export type Reason = (typeof REASONS)[number] | "user-decision" | "carried";

export interface Evidence {
  ref: string;
  state: FactState;
  value?: string;
  hash?: string;
}

export interface Decision {
  blockId: string;
  action: Action;
  reason: Reason;
  evidence: Evidence[];
  text: string; // replacement text for bind/rewrite
  note: string;
  flags: string[]; // why a human must look, or warnings
  proposed?: { action: Exclude<Action, "review">; text: string; reason: Reason }; // worker proposal parked for review
  origin: "worker" | "user" | "carried";
}

export interface Addition {
  id: string; // a1, a2…
  after: string; // block id
  text: string;
  evidence: Evidence[];
  note: string;
  flags: string[];
  status: "ok" | "review" | "dropped";
}

export type JobState = "brief" | "needs-review" | "ready" | "rejected" | "no-op" | "invalid" | "applied";
export type Verdict = "fit" | "no-op" | "reject" | "needs-review";

export interface Job {
  version: 1;
  id: string;
  rev: number;
  createdAt: string;
  tool: string;
  root: string;
  projectHash: string;
  source: SourceMeta;
  license: { spdx: string; path: string; text: string } | null;
  files: { path: string; content: string; hash: string }[];
  excluded: string[];
  findings: Finding[];
  original: { name: string; description: string };
  blocks: Block[];
  open: string[]; // block ids the worker had to decide (all, or only changed ones on update)
  worker: string;
  verdict: Verdict;
  summary: string;
  skill: { name: string; description: string };
  decisions: Decision[];
  additions: Addition[];
  errors: string[];
  state: JobState;
  targets: string[];
  updating?: string; // name of the managed skill this job updates
  manifest?: string;
  /** Upstream frontmatter fields that change agent behaviour (allowed-tools, …): a human keeps or drops them. */
  behavior?: { fields: string[]; decision: "pending" | "keep" | "drop" };
  /** Hashes of the instruction lines (AGENTS.md, CLAUDE.md…) the decisions were made against. */
  agentsAtAdoption?: string[];
  warnings?: string[];
}

/** Frontmatter keys that only describe the skill. Anything else may change how agents run it. */
export const INFO_FIELDS = new Set(["name", "description", "license", "metadata", "homepage", "version", "author", "authors", "tags", "group", "category", "compatibility", "repository", "keywords"]);

export function jobsDir(): string {
  return join(cacheHome(), "jobs");
}

export function jobDir(id: string): string {
  return join(jobsDir(), id);
}

export function saveJob(job: Job): void {
  mkdirSync(jobDir(job.id), { recursive: true });
  writeJson(join(jobDir(job.id), "job.json"), job);
}

/** Load by id, unique prefix, or "last" (most recent job for this project root). */
export function loadJob(ref: string, root?: string): Job {
  const dir = jobsDir();
  if (!existsSync(dir)) throw new UserError("No jobs yet. Run `skilladopt add <source>` first.");
  const ids = readdirSync(dir).filter((d) => existsSync(join(dir, d, "job.json")));
  let id: string | undefined;
  if (ref === "last") {
    const mine = ids
      .map((d) => ({ d, t: statSync(join(dir, d, "job.json")).mtimeMs, j: readJson<Job>(join(dir, d, "job.json")) }))
      .filter((x) => !root || x.j.root === root)
      .sort((a, b) => b.t - a.t);
    id = mine[0]?.d;
  } else {
    const matches = ids.filter((d) => d.startsWith(ref));
    if (matches.length > 1) throw new UserError(`Job id "${ref}" is ambiguous.`);
    id = matches[0];
  }
  if (!id) throw new UserError(`Job "${ref}" not found.`);
  return readJson<Job>(join(dir, id, "job.json"));
}

