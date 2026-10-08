import { existsSync } from "node:fs";
import { join } from "node:path";
import { dutyTerms, type Block } from "./blocks.js";
import { lookup, type Project } from "./facts.js";
import { REASONS, type Addition, type Decision, type Evidence, type Job, type Reason, type Verdict } from "./job.js";
import { scanOutput } from "./scan.js";
import type { RawDecisions } from "./worker.js";

const ACTIONS = new Set(["keep", "bind", "drop", "rewrite", "review"]);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function evidenceOf(project: Project, refs: string[]): Evidence[] {
  return [...new Set(refs.map((r) => r.trim()).filter(Boolean))].map((ref) => {
    const f = lookup(project, ref);
    return { ref, state: f.state, ...(f.value !== undefined ? { value: f.value.slice(0, 200) } : {}), ...(f.hash ? { hash: f.hash } : {}) };
  });
}

/**
 * Turn raw worker output into checked decisions. Hard errors make the job invalid;
 * anything the code cannot verify is parked as "review" with the worker's proposal attached.
 * The worker is never trusted: what is enforced here is enforced by code, not by the prompt.
 */
export function applyWorkerOutput(job: Job, raw: RawDecisions, project: Project): void {
  const errors: string[] = [];
  const byId = new Map(job.blocks.map((b) => [b.id, b]));
  const open = new Set(job.open);
  const seen = new Set<string>();
  const decisions: Decision[] = job.decisions.filter((d) => d.origin === "carried");

  if (!raw || typeof raw !== "object" || !Array.isArray(raw.blocks)) {
    job.errors = ["worker output is not a decision object"];
    job.state = "invalid";
    return;
  }
  for (const d of raw.blocks) {
    if (!d || typeof d.id !== "string") { errors.push("decision without id"); continue; }
    if (!open.has(d.id)) {
      if (byId.has(d.id)) continue; // already decided (carried); ignore re-decisions
      errors.push(`unknown block id ${d.id}`);
      continue;
    }
    if (seen.has(d.id)) { errors.push(`duplicate decision for ${d.id}`); continue; }
    seen.add(d.id);
    const action = ACTIONS.has(d.action) ? (d.action as Decision["action"]) : "review";
    const reason = (REASONS as readonly string[]).includes(d.reason) ? (d.reason as Reason) : "needs-human";
    const dec: Decision = {
      blockId: d.id,
      action,
      reason,
      evidence: evidenceOf(project, Array.isArray(d.evidence) ? d.evidence.map(String) : []),
      text: typeof d.text === "string" ? d.text.replace(/\r\n/g, "\n").trim() : "",
      note: typeof d.note === "string" ? d.note.slice(0, 500) : "",
      flags: [],
      origin: "worker",
    };
    checkDecision(dec, byId.get(d.id)!, project);
    decisions.push(dec);
  }
  for (const id of open) if (!seen.has(id)) errors.push(`no decision for ${id}`);

  // Additions carried from an earlier adoption (update) stay, including the ones parked for review.
  const additions: Addition[] = [...job.additions];
  let next = additions.reduce((m, a) => Math.max(m, Number(a.id.slice(1)) || 0), 0);
  (Array.isArray(raw.additions) ? raw.additions : []).forEach((a) => {
    const add: Addition = {
      id: `a${++next}`,
      after: String(a.after ?? ""),
      text: String(a.text ?? "").replace(/\r\n/g, "\n").trim(),
      evidence: evidenceOf(project, Array.isArray(a.evidence) ? a.evidence.map(String) : []),
      note: String(a.note ?? "").slice(0, 500),
      flags: ["new text written by the worker: needs a human look"],
      status: "review",
    };
    const anchor = byId.get(add.after);
    if (!anchor) { errors.push(`addition ${add.id} anchors to unknown block ${add.after}`); return; }
    if (!add.text) return;
    if (!add.evidence.some((e) => e.state === "present")) add.flags.push("no supporting evidence");
    for (const f of scanOutput(add.text, "")) add.flags.push(`${f.level === "reject" ? "UNSAFE" : "check"}: ${f.message}`);
    if (add.flags.some((f) => f.startsWith("UNSAFE"))) add.status = "dropped";
    additions.push(add);
  });

  const name = String(raw.skill?.name ?? "").trim();
  const description = String(raw.skill?.description ?? "").replace(/\s+/g, " ").trim();
  if (!NAME_RE.test(name) || name.length > 64) errors.push(`invalid skill name ${JSON.stringify(name)}`);
  if (!description || description.length > 1024) errors.push("skill description missing or longer than 1024 characters");
  for (const f of scanOutput(description, job.original.description)) if (f.level === "reject") errors.push(`description: ${f.message}`);

  job.decisions = sortDecisions(job, decisions);
  job.additions = additions;
  job.skill = job.updating ? { name: job.updating, description } : { name, description };
  job.summary = String(raw.summary ?? "").slice(0, 2000);
  job.verdict = (["fit", "no-op", "reject", "needs-review"].includes(raw.verdict) ? raw.verdict : "needs-review") as Verdict;
  job.errors = errors;
  refreshState(job);
}

function sortDecisions(job: Job, ds: Decision[]): Decision[] {
  const order = new Map(job.blocks.map((b, i) => [b.id, i]));
  return ds.sort((a, b) => (order.get(a.blockId) ?? 0) - (order.get(b.blockId) ?? 0));
}

// ---------------------------------------------------------------- bind verification

const CODE_SPAN = /`([^`\n]+)`/g;
const FILLER = new Set(["run", "runs", "with", "and", "or", "the", "a", "an", "using", "use", "via", "then", "for", "to", "it", "them", "in", "this", "project", "both", "e", "g", "eg", "i", "command", "script", "scripts"]);

function words(text: string): string[] {
  return text.replace(CODE_SPAN, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(CODE_SPAN)].map((m) => m[1]!.trim());
}


/**
 * The evidence ref for a command or path that demonstrably exists in this project (no shell tricks),
 * or null. `npm test` -> script:test, `src/ui/hud.ts` -> file:src/ui/hud.ts.
 */
export function projectReference(span: string, project: Project): string | null {
  if (/[;&|`$<>(){}\\]|\.\./.test(span)) return null;
  // Only forms that are guaranteed to run a package.json script: `<pm> run <script>`, and the
  // `test`/`start` shorthands of npm, pnpm and yarn. Built-ins such as `npm publish` or `npm install`
  // never count, even if a script with the same name exists (bun's `bun test` is its own runner).
  const m = /^(npm|pnpm|yarn|bun)\s+(run\s+)?([\w:.@/-]+)((?:\s+--?[\w:.=-]+)*)$/.exec(span);
  if (m) {
    const [, pm, run, script] = m as unknown as [string, string, string | undefined, string];
    const shorthand = !run && pm !== "bun" && (script === "test" || script === "start");
    return (run || shorthand) && project.scripts.has(script) ? `script:${script}` : null;
  }
  if (/^[\w./-]+$/.test(span) && !span.startsWith("/") && span.length < 200 && existsSync(join(project.root, span))) return `file:${span}`;
  return null;
}

/**
 * A bind may only replace ONE contiguous stretch of the original text, compared character by character.
 * Everything before and after that stretch must be byte-identical, the replaced stretch may not touch an
 * existing code span, carry a duty or a negation, or exceed 6 words, and the inserted text may only be
 * project commands/paths in code spans plus a few connective words. A bind can therefore never move,
 * negate, weaken or extend anything.
 */
export function bindCheck(original: string, next: string, project: Project): { problems: string[]; evidence: string[] } {
  const problems: string[] = [];
  const a = original.trim();
  const b = next.trim();
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  // Snap both cut points to word boundaries so a partial word is never treated as unchanged.
  const boundary = (ch: string | undefined) => ch === undefined || /[\s.,;:!?()[\]"'/]/.test(ch);
  while (pre > 0 && !boundary(a[pre - 1])) pre--;
  while (suf > 0 && !boundary(a[a.length - suf])) suf--;
  const removed = a.slice(pre, a.length - suf);
  const inserted = b.slice(pre, b.length - suf);

  if (removed.includes("`")) problems.push("bind changes an existing code span");
  if (words(removed).length > 6) problems.push(`bind replaces more than a reference: "${removed.slice(0, 60)}"`);
  if (dutyTerms(removed).length || NEGATION.test(removed)) problems.push(`bind replaces words that carry a duty or negation: "${removed.slice(0, 60)}"`);
  // The inserted text must be exactly one code span: no words, no punctuation, no second sentence.
  const spans = codeSpans(inserted);
  if (!/^`[^`\n]+`$/.test(inserted.trim())) problems.push(`bind may only insert a single command or path, got: "${inserted.slice(0, 60)}"`);
  const evidence: string[] = [];
  for (const span of spans) {
    const ref = projectReference(span, project);
    if (ref) evidence.push(ref);
    else problems.push(`\`${span.slice(0, 60)}\` is not a command or file of this project`);
  }
  return { problems, evidence };
}

const NEGATION = /\b(not|no|never|without|unless|only|except|avoid|don't|do not|must)\b/i;

// ---------------------------------------------------------------- policy

/** Enforce the policy on one decision. Moves anything unverifiable to review, keeping the proposal. */
export function checkDecision(dec: Decision, block: Block, project: Project): void {
  const park = (why: string) => {
    dec.flags.push(why);
    if (dec.action !== "review") {
      dec.proposed = { action: dec.action, text: dec.text, reason: dec.reason };
      dec.action = "review";
      dec.text = "";
    }
  };
  const absent = dec.evidence.filter((e) => e.state === "absent");

  if (dec.action === "bind" || dec.action === "rewrite") {
    if (!dec.text) { park(`${dec.action} without replacement text`); return; }
    // Risk is judged against this block only: an example elsewhere in the skill is no licence here.
    const findings = scanOutput(dec.text, block.text);
    const unsafe = findings.filter((f) => f.level === "reject");
    if (unsafe.length) {
      dec.flags.push(...unsafe.map((f) => `UNSAFE: ${f.message}`));
      dec.proposed = undefined;
      dec.action = "review";
      dec.text = "";
      return;
    }
    for (const f of findings) park(`check: ${f.message}`);
  }

  switch (dec.action) {
    case "keep":
      dec.text = "";
      if (block.risk.length) park(`kept block has risk: ${block.risk.join(", ")}`);
      break;
    case "bind": {
      const { problems, evidence } = bindCheck(block.text, dec.text, project);
      // The code, not the worker, records what the bind relies on, so impact can see it change.
      const known = new Set(dec.evidence.map((e) => e.ref));
      dec.evidence.push(...evidenceOf(project, evidence.filter((r) => !known.has(r))));
      for (const p of problems) park(p);
      if (block.obligation) park("binds a block that carries a duty (prohibition / approval / verification)");
      if (block.risk.length) park(`rewritten block has risk: ${block.risk.join(", ")}`);
      break;
    }
    case "rewrite":
      park(block.obligation ? "rewrites a block that carries a duty (prohibition / approval / verification)" : "rewritten text needs a human look");
      break;
    case "drop":
      dec.text = "";
      if (block.obligation) park("drops a block that carries a duty (prohibition / approval / verification)");
      else if (dec.reason === "stack-mismatch") {
        if (!absent.length) park("stack-mismatch without any fact that is actually absent");
        const wrong = dec.evidence.filter((e) => e.state === "present");
        if (wrong.length) park(`stack-mismatch cites facts that are present: ${wrong.map((e) => e.ref).join(", ")}`);
      } else if (dec.reason === "duplicate-of-agents-md" || dec.reason === "conflict-with-agents-md") {
        if (!dec.evidence.some((e) => e.ref.startsWith("agents:") && e.state === "present")) park(`${dec.reason} without a valid agents:<file>:<line> reference`);
      } else if (dec.reason === "universal" || dec.reason === "project-fit") {
        park(`drop with reason "${dec.reason}" makes no sense`);
      } else if (!dec.evidence.length) {
        park(`drop (${dec.reason}) without evidence`);
      }
      break;
    case "review":
      dec.text = "";
      if (!dec.flags.length) dec.flags.push(dec.note ? `worker unsure: ${dec.note}` : "worker asked for a human decision");
      break;
  }
}

export function refreshState(job: Job): void {
  if (job.errors.length) { job.state = "invalid"; return; }
  if (job.verdict === "reject") { job.state = "rejected"; return; }
  if (job.verdict === "no-op") { job.state = "no-op"; return; }
  const pending = job.decisions.some((d) => d.action === "review") || job.additions.some((a) => a.status === "review") || job.behavior?.decision === "pending";
  job.state = pending ? "needs-review" : "ready";
  if (job.state === "ready" && job.verdict === "needs-review") job.verdict = "fit";
}

/** Apply a human decision: keep | drop | accept (take the worker's parked proposal). */
export function decide(job: Job, id: string, choice: string, project?: Project): string {
  if (id === "fm") {
    if (!job.behavior) return "this skill has no behaviour fields to decide";
    if (choice === "keep" || choice === "accept") job.behavior.decision = "keep";
    else if (choice === "drop") job.behavior.decision = "drop";
    else return "use fm=keep or fm=drop";
    return "";
  }
  if (/^a\d+$/.test(id)) {
    const add = job.additions.find((a) => a.id === id);
    if (!add) return `unknown addition ${id}`;
    if (add.status === "dropped") return `${id} was flagged unsafe and cannot be accepted`;
    if (choice === "accept" || choice === "keep") add.status = "ok";
    else if (choice === "drop") add.status = "dropped";
    else return `use ${id}=accept or ${id}=drop`;
    add.flags = [];
    // The human approved it against the project as it is now: record today's evidence.
    if (project) add.evidence = evidenceOf(project, add.evidence.map((e) => e.ref));
    return "";
  }
  const dec = job.decisions.find((d) => d.blockId === id);
  if (!dec) return `unknown block ${id}`;
  if (choice === "keep") {
    Object.assign(dec, { action: "keep", reason: "user-decision", text: "", origin: "user" });
  } else if (choice === "drop") {
    Object.assign(dec, { action: "drop", reason: "user-decision", text: "", origin: "user" });
  } else if (choice === "accept") {
    if (!dec.proposed) return `${id} has no proposal to accept (use keep or drop)`;
    Object.assign(dec, { action: dec.proposed.action, text: dec.proposed.text, reason: "user-decision", origin: "user" });
  } else return `use ${id}=keep, ${id}=drop or ${id}=accept`;
  dec.flags = [];
  dec.proposed = undefined;
  if (project) dec.evidence = evidenceOf(project, dec.evidence.map((e) => e.ref));
  return "";
}
