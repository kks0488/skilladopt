#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { dirname, join, posix, resolve } from "node:path";
import { parseFrontmatter } from "./blocks.js";
import { projectHash, readProject, type Project } from "./facts.js";
import { blocksOf, evidenceDrift, projectImpact, type SkillImpact } from "./impact.js";
import { INFO_FIELDS, jobDir, loadJob, saveJob, type Decision, type Job } from "./job.js";
import { danglingReferences, licenseAllowsCommit, manifestOf, render } from "./render.js";
import { classifyFile, localReferences, scanInput } from "./scan.js";
import { fetchGithub, fetchLocal, parseSource, type FetchedSource, type SourceMeta } from "./source.js";
import { applyFiles, pendingJournal, readDecisions, readLock, recover } from "./store.js";
import { applyWorkerOutput, decide, refreshState } from "./validate.js";
import { buildBrief, detectWorker, doctor, runWorker, type RawDecisions, type WorkerKind } from "./worker.js";
import { c, oneLine, randomId, readJson, safePrint, UserError, VERSION, writeFileAtomic } from "./util.js";

const HELP = `skilladopt ${VERSION} — Don't install agent skills. Adopt them.

Usage
  skilladopt setup               Teach Claude Code and Codex to adopt skills: after this, just ask your agent
  skilladopt <repo> [skill]      Fit a skill to this project and install it (asks before installing).
  skilladopt add <repo> [skill]  Same; "add" is optional. <repo> is a GitHub link, owner/repo,
                                 owner/repo/path or ./local/dir; [skill] picks one skill by name
  skilladopt review <job>        Show items that need a human; decide with --decide <id>=keep|drop|accept
  skilladopt apply <job>         Install the adopted skill (transactional)
  skilladopt impact              What did project changes invalidate? (add --upstream to check sources)
  skilladopt update <name>       Re-fit an adopted skill to its latest upstream; only changed parts are re-decided
  skilladopt status              Adopted skills, local edits
  skilladopt recover             Roll back an apply that was interrupted
  skilladopt doctor              Probe the worker's isolation on this machine (canary file, env, write)

Options
  --worker codex|claude|manual   Who reads the skill (default: auto). The worker only receives the skill text
                                 and a project summary in its prompt. claude runs with --safe-mode and no tools;
                                 codex runs in a read-only sandbox without network tools or access to your home.
  --model <name>                 Model for the worker
  --decisions <file>             Use a decisions JSON instead of running a worker
  --target both|codex|claude     Where to install: .agents/skills, .claude/skills or both (default: both)
  --name <name>                  Name for the adopted skill
  --yes                          Apply right away when nothing needs review
  --force                        Overwrite unmanaged or hand-edited skill folders
  --private                      Allow skills without a recognised permissive license: installs and records
                                 are added to .git/info/exclude (refused if git already tracks them)
  --json                         Machine-readable output (impact, status)
  --cwd <dir>                    Project directory (default: current git root)

<job> is a job id, a prefix of it, or "last".`;

interface Opts {
  _: string[];
  worker?: string;
  model?: string;
  decisions?: string;
  target?: string;
  name?: string;
  decide: string[];
  yes: boolean;
  force: boolean;
  private: boolean;
  json: boolean;
  upstream: boolean;
  cwd?: string;
  ref?: string;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { _: [], decide: [], yes: false, force: false, private: false, json: false, upstream: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UserError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--worker": o.worker = val(); break;
      case "--model": o.model = val(); break;
      case "--decisions": o.decisions = val(); break;
      case "--target": o.target = val(); break;
      case "--name": o.name = val(); break;
      case "--decide": o.decide.push(...val().split(",")); break;
      case "--cwd": o.cwd = val(); break;
      case "--ref": o.ref = val(); break;
      case "--yes": case "-y": o.yes = true; break;
      case "--force": o.force = true; break;
      case "--private": o.private = true; break;
      case "--json": o.json = true; break;
      case "--upstream": o.upstream = true; break;
      default:
        if (a.startsWith("-")) throw new UserError(`Unknown option ${a}`);
        o._.push(a);
    }
  }
  return o;
}

function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

const log = (s = "") => process.stdout.write(s + "\n");

// ---------------------------------------------------------------- add / update

async function fetchSource(meta: string | SourceMeta, ref?: string, name?: string): Promise<FetchedSource> {
  if (typeof meta === "string") {
    const spec = parseSource(meta);
    if (spec.type === "github" && name) spec.name = name;
    return spec.type === "local" ? await fetchLocal(spec.dir) : fetchGithub(spec);
  }
  if (meta.type === "local") return await fetchLocal(meta.dir!);
  return fetchGithub({ type: "github", owner: meta.owner!, repo: meta.repo!, path: meta.path ?? "", ref: ref ?? meta.ref });
}

function inspect(src: FetchedSource): { blocks: ReturnType<typeof blocksOf>; problems: string[]; warnings: string[] } {
  const problems = src.findings.filter((f) => f.level === "reject").map((f) => f.message);
  const warnings: string[] = [];
  const blocks = blocksOf(src.files);
  const texts = new Set(src.files.map((f) => f.path));
  for (const f of src.files) {
    const kind = classifyFile(f.path);
    for (const finding of scanInput(f.content)) {
      // License and notice files are copied verbatim, so anything suspicious in them is a refusal.
      if (finding.level === "reject" || kind === "license") problems.push(`${f.path}: ${finding.message}`);
    }
    if (kind === "markdown") {
      const fm = parseFrontmatter(f.content);
      if (fm.unparsed.length) problems.push(`${f.path}: frontmatter syntax not supported yet: ${fm.unparsed[0]!.slice(0, 60)}`);
    }
    if (classifyFile(f.path) !== "markdown") continue;
    for (const ref of localReferences(f.content)) {
      const resolved = posix.normalize(posix.join(posix.dirname(f.path), ref));
      if (resolved.startsWith("../") || resolved === "..") {
        if (/(^|\/)SKILL\.md$/i.test(ref)) warnings.push(`${f.path} links to another skill (${ref}); adopt it separately if you need it`);
        else if (f.path.startsWith("bundled/")) warnings.push(`${f.path} mentions ${ref}; bundled docs are not followed further`);
        else problems.push(`${f.path} references ${ref}, outside the skill folder and not a Markdown file in the same repository`);
      } else if (src.excluded.includes(resolved)) {
        problems.push(`${f.path} needs ${resolved}, a script/asset file (skills with code are not supported yet)`);
      } else if (!texts.has(resolved) && !/^https?:/.test(ref)) {
        warnings.push(`${f.path} mentions ${ref}, which is not in the skill folder`);
      }
    }
  }
  for (const b of blocks) {
    b.risk = scanInput(b.text).filter((x) => x.level === "review").map((x) => x.code);
  }
  for (const e of src.excluded) if (!problems.some((p) => p.includes(e))) warnings.push(`not copied (not text): ${e}`);
  return { blocks, problems, warnings };
}

function newJob(root: string, project: Project, src: FetchedSource, blocks: ReturnType<typeof blocksOf>, worker: string, targets: string): Job {
  const skillMd = src.files.find((f) => f.path === "SKILL.md");
  const parsed = parseFrontmatter(skillMd?.content ?? "");
  const fm = parsed.fields;
  const behaviorFields = parsed.entries.map((e) => e.key).filter((k) => !INFO_FIELDS.has(k));
  return {
    version: 1,
    id: randomId(),
    rev: 1,
    createdAt: new Date().toISOString(),
    tool: VERSION,
    root,
    projectHash: projectHash(project),
    source: src.meta,
    license: src.license,
    files: src.files,
    excluded: src.excluded,
    findings: src.findings,
    original: { name: fm.name ?? "", description: fm.description ?? "" },
    blocks,
    open: blocks.map((b) => b.id),
    worker,
    verdict: "needs-review",
    summary: "",
    skill: { name: "", description: "" },
    decisions: [],
    additions: [],
    errors: [],
    state: "brief",
    targets: [targets],
    ...(behaviorFields.length ? { behavior: { fields: behaviorFields, decision: "pending" as const } } : {}),
  };
}

function targetDirs(kind: string, name: string): string[] {
  const k = kind || "both";
  if (!["both", "codex", "claude"].includes(k)) throw new UserError("--target must be both, codex or claude");
  return [...(k !== "claude" ? [`.agents/skills/${name}`] : []), ...(k !== "codex" ? [`.claude/skills/${name}`] : [])];
}

async function decideWith(job: Job, project: Project, opts: Opts, carriedSummary: string[]): Promise<void> {
  const kind = (opts.decisions ? "manual" : opts.worker ?? detectWorker()) as WorkerKind;
  if (!["codex", "claude", "manual"].includes(kind)) throw new UserError("--worker must be codex, claude or manual");
  job.worker = opts.decisions ? `file:${opts.decisions}` : kind;
  const brief = buildBrief(job, project, carriedSummary);
  if (job.open.length === 0) {
    applyWorkerOutput(job, { verdict: "fit", summary: "No upstream changes needed a new decision.", skill: job.skill, blocks: [], additions: [] }, project);
    return;
  }
  const how = opts.decisions ? "decisions read from file" : kind === "claude" ? "claude --safe-mode, no tools" : kind === "codex" ? "codex read-only sandbox, no network tool access, no home dir" : "manual";
  log(c.dim(`worker   ${job.worker} · ${how} · gets the skill text + a project summary · ${job.open.length} block(s) to decide`));
  const raw: RawDecisions | null = opts.decisions ? readJson<RawDecisions>(resolve(opts.decisions)) : await runWorker(kind, job, brief, opts.model);
  if (!raw) {
    job.state = "brief";
    saveJob(job);
    log();
    log(`Brief written for a manual worker:`);
    log(`  ${join(jobDir(job.id), "brief.md")}`);
    log(`  schema: ${join(jobDir(job.id), "schema.json")}`);
    log(`Have an agent answer it as JSON, then run: skilladopt add ${job.source.id.replace(/^github:/, "")} --decisions <answer.json>`);
    return;
  }
  applyWorkerOutput(job, raw, project);
}


async function finish(job: Job, opts: Opts, root: string): Promise<number> {
  if (job.state !== "invalid" && job.skill.name) {
    if (opts.name) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(opts.name) || opts.name.length > 64) throw new UserError("--name must be lowercase-hyphenated, max 64 chars");
      job.skill.name = opts.name;
    }
    if (!job.updating) {
      job.targets = targetDirs(opts.target ?? "both", job.skill.name);
      const prev = readLock(root).skills[job.skill.name];
      if (prev && prev.source.id === job.source.id) job.targets = [...new Set([...prev.targets, ...job.targets])];
    }
  }
  sealIfReady(job);
  saveJob(job);
  printJob(job);
  if (interactive(opts)) return askAndApply(job, opts, root);
  if (job.state === "ready" && opts.yes) return doApply(job, opts, root);
  return job.state === "ready" || job.state === "applied" ? 0 : job.state === "invalid" ? 2 : 1;
}

// ---------------------------------------------------------------- setup

const PERSONAL_SKILL_DIRS = [".claude/skills/skilladopt", ".agents/skills/skilladopt"];

/** Puts the skilladopt agent skill where Claude Code and Codex look for personal skills. */
function cmdSetup(opts: Opts): number {
  const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "skilladopt", "SKILL.md"), "utf8");
  const home = process.env.SKILLADOPT_SETUP_HOME ?? homedir();
  for (const dir of PERSONAL_SKILL_DIRS) {
    const file = join(home, dir, "SKILL.md");
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current === skill) { log(`${c.green("✓")} ~/${dir} is up to date`); continue; }
    if (current !== null && !opts.force) { log(`${c.yellow("kept")} ~/${dir} (it differs from this version; --force replaces it)`); continue; }
    writeFileAtomic(file, skill);
    log(`${c.green("✓")} ~/${dir}`);
  }
  log(`\nNow open Claude Code or Codex in a project and ask for a skill, for example:\n  ${c.bold('"Add a frontend design skill to this project."')}\nYour agent finds one, fits it with skilladopt and asks you before installing.`);
  return 0;
}

async function offerSetup(): Promise<number> {
  log(HELP);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question("Set up skilladopt for Claude Code and Codex now? [Y/n] ")).trim().toLowerCase();
    return a === "" || a === "y" || a === "yes" ? cmdSetup(parseArgs([])) : 0;
  } catch (e) {
    if ((e as Error).name === "AbortError") return 0;
    throw e;
  } finally { rl.close(); }
}

/** A person at a terminal (not an agent, CI or a pipe) gets asked instead of handed commands. */
function interactive(opts: Opts): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && !opts.decisions && !opts.yes && !process.env.CI;
}

async function askAndApply(job: Job, opts: Opts, root: string): Promise<number> {
  if (job.state !== "needs-review" && job.state !== "ready") return job.state === "invalid" ? 2 : 1;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const blocks = new Map(job.blocks.map((b) => [b.id, b]));
    const items = [
      ...job.decisions.filter((d) => d.action === "review").map((d) => d.blockId),
      ...job.additions.filter((a) => a.status === "review").map((a) => a.id),
      ...(job.behavior?.decision === "pending" ? ["fm"] : []),
    ];
    for (const id of items) {
      const d = job.decisions.find((x) => x.blockId === id);
      const a = job.additions.find((x) => x.id === id);
      log();
      if (id === "fm") log(`${c.bold("fm")}  frontmatter fields that change agent behaviour: ${job.behavior!.fields.join(", ")}`);
      else if (a) { log(`${c.bold(id)}  new text after ${a.after}:`); log(c.blue(indent(safePrint(a.text), 4))); }
      else if (d) {
        log(`${c.bold(id)}  ${safePrint(d.flags[0] ?? "")}`);
        log(c.dim(indent(safePrint(blocks.get(id)!.text), 4)));
        if (d.proposed?.text) { log(c.dim("    ── proposed ──")); log(c.blue(indent(safePrint(d.proposed.text), 4))); }
      }
      const canAccept = !!(a || d?.proposed || id === "fm");
      const prompt = canAccept ? `${c.yellow("?")} [a]ccept, [k]eep original, [d]rop: ` : `${c.yellow("?")} [k]eep original, [d]rop: `;
      for (;;) {
        const answer = (await rl.question(prompt)).trim().toLowerCase();
        const choice = answer.startsWith("a") && canAccept ? "accept" : answer.startsWith("k") ? "keep" : answer.startsWith("d") ? "drop" : "";
        if (!choice) continue;
        const err = decide(job, id, choice, readProject(root));
        if (!err) break;
        log(c.yellow(err));
      }
    }
    if (items.length) {
      job.rev += 1;
      refreshState(job);
      sealIfReady(job);
      saveJob(job);
    }
    if (job.state !== "ready") return 1;
    const where = job.targets.join(", ");
    if (!licenseAllowsCommit(job) && !opts.private) {
      const ok = (await rl.question(`\n${c.yellow("?")} No recognised open-source license (${job.license?.spdx ?? "none"}). Install privately, kept out of git? [y/N] `)).trim().toLowerCase();
      if (!ok.startsWith("y")) { log(c.dim("Not installed.")); return 0; }
      opts.private = true;
    } else {
      const yes = (await rl.question(`\n${c.green("?")} Install ${c.bold(job.skill.name)} into ${where}? [Y/n] `)).trim().toLowerCase();
      if (yes && !yes.startsWith("y")) { log(c.dim(`Not installed. Later: skilladopt apply ${job.id}`)); return 0; }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") { log(c.dim(`\nCancelled. Nothing was installed. Later: skilladopt review ${job.id}`)); return 1; }
    throw e;
  } finally {
    rl.close();
  }
  return doApply(job, opts, root);
}

function sealIfReady(job: Job): void {
  if (job.state !== "ready") { job.manifest = undefined; return; }
  const files = render(job);
  job.warnings = danglingReferences(files);
  job.manifest = manifestOf(job, files);
}

async function cmdAdd(opts: Opts, root: string): Promise<number> {
  const spec = opts._[1];
  if (!spec) throw new UserError("Usage: skilladopt add <github-repo-or-url> [skill-name]");
  const project = readProject(root);
  const src = await fetchSource(spec, undefined, opts._[2]);
  const { blocks, problems, warnings } = inspect(src);
  printSource(src, project, warnings);
  if (problems.length) {
    log();
    log(`${c.red("REJECTED")} before any AI saw it:`);
    for (const p of problems) log(`  ${c.red("✗")} ${safePrint(p)}`);
    return 1;
  }
  const job = newJob(root, project, src, blocks, "", opts.target ?? "both");
  await decideWith(job, project, opts, []);
  if (job.state === "brief") return 0;
  return finish(job, opts, root);
}

async function cmdUpdate(opts: Opts, root: string): Promise<number> {
  const name = opts._[1];
  if (!name) throw new UserError("Usage: skilladopt update <name>");
  const lock = readLock(root);
  const entry = lock.skills[name];
  const rec = readDecisions(root, name);
  if (!entry || !rec) throw new UserError(`"${name}" is not adopted in this project.`);
  const project = readProject(root);
  const src = await fetchSource(entry.source, opts.ref);
  const { blocks, problems, warnings } = inspect(src);
  printSource(src, project, warnings);
  if (problems.length) {
    for (const p of problems) log(`  ${c.red("✗")} ${safePrint(p)}`);
    return 1;
  }
  const job = newJob(root, project, src, blocks, "", "both");
  job.updating = name;
  job.targets = entry.targets;
  job.skill = { name, description: rec.description };

  // Carry decisions whose block, enclosing headings and evidence are all unchanged.
  const oldByHash = new Map(rec.blocks.map((b) => [`${b.file}\n${b.hash}`, b]));
  const oldById = new Map(rec.blocks.map((b) => [b.id, b]));
  const newById = new Map(blocks.map((b) => [b.id, b]));
  const sameChain = (newId: string | null, oldId: string | null): boolean => {
    while (newId || oldId) {
      const n = newId ? newById.get(newId) : undefined;
      const o = oldId ? oldById.get(oldId) : undefined;
      if (!n || !o || n.hash !== o.hash) return false;
      newId = n.parent;
      oldId = o.parent;
    }
    return true;
  };
  const carried: Decision[] = [];
  const carriedSummary: string[] = [];
  const known = new Set(entry.agents ?? project.agents.map((a) => a.hash));
  const newRules = project.agents.filter((a) => !known.has(a.hash)).length;
  if (newRules) log(c.dim(`rules    ${newRules} instruction line(s) changed since adoption: every paragraph is decided again`));
  for (const b of newRules ? [] : blocks) {
    const old = oldByHash.get(`${b.file}\n${b.hash}`);
    if (!old || !sameChain(b.parent, old.parent)) continue;
    const d = old.decision;
    if (d.evidence.some((e) => evidenceDrift(project, e))) continue;
    carried.push({ ...d, blockId: b.id, origin: "carried", flags: [] });
    carriedSummary.push(`${b.id}: ${d.action}${d.reason !== "universal" ? ` (${d.reason})` : ""}`);
  }
  job.decisions = carried;
  job.open = blocks.map((b) => b.id).filter((id) => !carried.some((d) => d.blockId === id));
  // Earlier additions are never dropped silently: unchanged ones are carried, the rest wait for a human.
  for (const a of rec.additions) {
    const anchor = oldById.get(a.after);
    const nb = anchor ? blocks.find((b) => b.hash === anchor.hash && b.file === anchor.file) : undefined;
    const drift = a.evidence.map((e) => evidenceDrift(project, e)).filter((x): x is string => !!x);
    const anchorCarried = !!nb && carried.some((d) => d.blockId === nb.id);
    if (anchorCarried && !drift.length) { job.additions.push({ ...a, after: nb!.id }); continue; }
    const fallback = blocks.filter((b) => b.file === (anchor?.file ?? "SKILL.md")).at(-1) ?? blocks.at(-1)!;
    job.additions.push({
      ...a,
      after: nb?.id ?? fallback.id,
      status: "review",
      flags: [drift.length ? `evidence changed: ${drift.join("; ")}` : newRules ? "instruction lines changed since adoption: check it again" : "the paragraph it follows changed upstream"],
    });
  }
  log(c.dim(`reuse    ${carried.length} of ${blocks.length} decisions carried (block, section and evidence unchanged) · ${job.open.length} to decide again`));
  await decideWith(job, project, opts, carriedSummary);
  if (job.state === "brief") return 0;
  return finish(job, opts, root);
}

// ---------------------------------------------------------------- review / apply

function cmdReview(opts: Opts, root: string): number {
  const job = loadJob(opts._[1] ?? "last", root);
  if (opts.decide.length) {
    const project = readProject(root);
    for (const d of opts.decide) {
      const [id, choice] = d.split("=");
      if (!id || !choice) throw new UserError(`--decide expects <id>=keep|drop|accept, got "${d}"`);
      if (id === "all") {
        for (const x of job.decisions.filter((x) => x.action === "review")) {
          const err = decide(job, x.blockId, choice, project);
          if (err) log(c.yellow(`  ${x.blockId}: ${err}`));
        }
        for (const a of job.additions.filter((a) => a.status === "review")) decide(job, a.id, choice === "keep" ? "accept" : choice, project);
        continue;
      }
      const err = decide(job, id.trim(), choice.trim(), project);
      if (err) throw new UserError(err);
    }
    job.rev += 1;
    refreshState(job);
    sealIfReady(job);
    saveJob(job);
    log(c.dim(`decisions recorded · job ${job.id} sealed as revision ${job.rev}`));
    printJob(job);
    return job.state === "ready" ? 0 : 1;
  }
  printJob(job, true);
  return job.state === "ready" ? 0 : 1;
}

function cmdApply(opts: Opts, root: string): number {
  const job = loadJob(opts._[1] ?? "last", root);
  return doApply(job, opts, root);
}

function doApply(job: Job, opts: Opts, root: string): number {
  if (job.root !== root) throw new UserError(`Job ${job.id} belongs to ${job.root}. Run it from there or pass --cwd.`);
  if (job.state === "applied") { log(`Job ${job.id} is already applied.`); return 0; }
  if (job.state !== "ready") throw new UserError(`Job ${job.id} is ${job.state}; nothing to apply.${job.state === "needs-review" ? ` Run skilladopt review ${job.id}` : ""}`);
  const project = readProject(root);
  if (projectHash(project) !== job.projectHash) {
    throw new UserError("The project changed since this job was prepared (dependencies, scripts or AGENTS.md). Run add/update again so decisions use current facts.");
  }
  const drift = [...job.decisions.flatMap((d) => d.evidence), ...job.additions.filter((a) => a.status === "ok").flatMap((a) => a.evidence)]
    .map((e) => evidenceDrift(project, e))
    .filter((x): x is string => !!x);
  if (drift.length) throw new UserError(`Evidence changed since this job was prepared:\n  ${drift.slice(0, 5).join("\n  ")}\nRun add/update again.`);
  const files = render(job);
  if (manifestOf(job, files) !== job.manifest) throw new UserError("The job no longer matches what was reviewed. Run review again.");
  if (!licenseAllowsCommit(job) && !opts.private) {
    throw new UserError(`License is ${job.license?.spdx ?? "missing"}; skilladopt only commits adapted copies of permissively licensed skills. Use --private to install it outside git.`);
  }
  job.agentsAtAdoption = project.agents.map((a) => a.hash);
  const failAfter = process.env.SKILLADOPT_TEST_FAIL_AFTER as "staged" | "swapped" | "records" | "kill-after-staged" | undefined; // test hook
  const result = applyFiles(job, files, { force: opts.force, private: opts.private || !licenseAllowsCommit(job), failAfter });
  job.state = "applied";
  saveJob(job);
  if (result === "unchanged") log("Already installed; nothing changed.");
  else {
    log(`${c.green("✓")} adopted ${c.bold(job.skill.name)} → ${job.targets.join(", ")}`);
    log(c.dim(`  evidence for every decision: .skilladopt/decisions/${job.skill.name}.json`));
    log(c.dim("  later, run `skilladopt impact` to see which decisions your project changes invalidate."));
  }
  return 0;
}

// ---------------------------------------------------------------- impact / status

async function cmdImpact(opts: Opts, root: string): Promise<number> {
  const project = readProject(root);
  const lock = readLock(root);
  const names = Object.keys(lock.skills);
  if (!names.length) { log("No adopted skills in this project yet."); return 0; }
  let upstream: Map<string, FetchedSource | Error> | undefined;
  if (opts.upstream) {
    upstream = new Map();
    for (const [name, entry] of Object.entries(lock.skills)) {
      try { upstream.set(name, await fetchSource(entry.source)); } catch (e) { upstream.set(name, e as Error); }
    }
  }
  const report = projectImpact(project, upstream);
  if (opts.json) { log(JSON.stringify(report, null, 2)); return report.some(needsAttention) ? 1 : 0; }
  for (const r of report) printImpact(r, opts.upstream);
  const bad = report.filter(needsAttention);
  log();
  if (!bad.length) log(`${c.green("✓")} no change in the evidence behind any recorded decision${opts.upstream ? "" : c.dim(" (upstream not checked; add --upstream)")}`);
  else log(`${c.yellow("!")} ${bad.length} skill(s) need a look. Re-fit with: skilladopt update <name>`);
  return bad.length ? 1 : 0;
}

function needsAttention(r: SkillImpact): boolean {
  return r.stale.length > 0 || r.localEdits.length > 0 || !!r.upstream || !!r.missingRecord || !!r.newRules?.length;
}

function printImpact(r: SkillImpact, checkedUpstream: boolean): void {
  log();
  const holds = r.total - r.stale.length;
  const head = r.stale.length ? c.yellow(`${r.stale.length} of ${r.total} decisions need a re-check`) : c.green(`evidence unchanged for all ${r.total} decisions`);
  log(`${c.bold(r.name)}  ${head}${r.stale.length ? c.dim(` · ${holds} unaffected`) : ""}`);
  for (const s of r.stale) log(`  ${c.yellow("↻")} ${s.where.padEnd(4)} ${s.action.padEnd(7)} ${c.dim(s.reason.padEnd(24))} ${safePrint(s.why)}`);
  if (r.localEdits.length) log(`  ${c.magenta("✎")} edited by hand: ${r.localEdits.join(", ")}`);
  if (r.newRules?.length) {
    log(`  ${c.yellow("✚")} ${r.newRules.length} instruction line(s) added or changed since adoption; kept paragraphs were not checked against them:`);
    for (const rule of r.newRules.slice(0, 5)) log(`      ${safePrint(rule)}`);
  }
  if (r.missingRecord) log(`  ${c.red("?")} decision record missing (.skilladopt/decisions/${r.name}.json)`);
  if (r.upstream && "error" in r.upstream) log(`  ${c.red("!")} upstream check failed: ${safePrint(r.upstream.error)}`);
  else if (r.upstream) {
    const u = r.upstream;
    log(`  ${c.blue("⇡")} upstream moved ${u.from.slice(0, 7)} → ${u.to.slice(0, 7)}: ${u.affected.length} decision(s) affected, ${u.added} new block(s)`);
    for (const s of u.affected.slice(0, 12)) log(`      ${s.where.padEnd(4)} ${s.action.padEnd(7)} ${c.dim(s.why)}`);
  } else if (checkedUpstream) log(c.dim("  upstream unchanged"));
}

function cmdStatus(opts: Opts, root: string): number {
  const lock = readLock(root);
  const entries = Object.entries(lock.skills);
  if (opts.json) { log(JSON.stringify(lock, null, 2)); return 0; }
  if (!entries.length) { log("No adopted skills in this project yet. Try: skilladopt add <github-url>"); return 0; }
  const project = readProject(root);
  const report = new Map(projectImpact(project).map((r) => [r.name, r]));
  for (const [name, e] of entries) {
    const r = report.get(name)!;
    const flags = [r.stale.length ? c.yellow(`${r.stale.length} stale`) : c.green("ok"), r.localEdits.length ? c.magenta("edited") : ""].filter(Boolean).join(" ");
    log(`${c.bold(name.padEnd(28))} ${flags.padEnd(12)} ${c.dim(`${e.source.id} @ ${(e.source.commit ?? "").slice(0, 7)} · ${e.license} · ${e.adoptedAt}`)}`);
  }
  return 0;
}

// ---------------------------------------------------------------- printing

function printSource(src: FetchedSource, project: Project, warnings: string[]): void {
  const where = src.meta.commit ? `${src.meta.id} @ ${src.meta.commit.slice(0, 7)}` : src.meta.id;
  log(`${c.dim("source  ")} ${safePrint(where)} · ${src.license ? src.license.spdx : c.yellow("no license found")}`);
  const langs = [...project.languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l).join(", ");
  const agentFiles = [...new Set(project.agents.map((a) => a.file))];
  log(`${c.dim("project ")} ${[...project.ecosystems].join(", ") || "?"} · ${langs || "?"} · ${project.deps.size} deps · ${project.scripts.size} scripts · ${agentFiles.length ? agentFiles.join(", ") : "no AGENTS.md"}`);
  const files = src.files.map((f) => f.path).join(", ");
  log(`${c.dim("files   ")} ${safePrint(files)}`);
  for (const w of warnings) log(`${c.dim("note    ")} ${c.yellow(safePrint(w))}`);
  if (project.agents.length > 400) {
    log(`${c.dim("note    ")} ${c.yellow(`your instruction files have ${project.agents.length} non-empty lines; only the first 400 are shown to the worker, so later rules were not considered`)}`);
  }
}

const ACTION_COLOR: Record<string, (s: string) => string> = { keep: c.dim, bind: c.cyan, rewrite: c.blue, drop: c.red, review: c.yellow };

function printJob(job: Job, full = false): void {
  log();
  if (job.state === "invalid") {
    log(`${c.red("INVALID")} worker output failed validation:`);
    for (const e of job.errors.slice(0, 20)) log(`  ✗ ${safePrint(e)}`);
    log(c.dim("Nothing was installed. Run add again (or with another --worker)."));
    return;
  }
  const verdictColor = job.state === "ready" ? c.green : job.state === "rejected" ? c.red : c.yellow;
  log(`${c.bold("verdict")}  ${verdictColor(job.state === "ready" ? "fit" : job.state)}  ${c.dim(oneLine(job.summary, 96))}`);
  if (job.state === "rejected") { log(c.dim("The worker judged this skill not to fit this project. Nothing to install.")); return; }
  if (job.state === "no-op") { log(c.dim("This skill adds nothing beyond what the project already has. Nothing to install.")); return; }
  if (job.skill.name) log(`${c.bold("skill  ")}  ${job.skill.name} ${c.dim(`— ${oneLine(job.skill.description, 90)}`)}`);
  const counts: Record<string, number> = {};
  for (const d of job.decisions) counts[d.action] = (counts[d.action] ?? 0) + 1;
  const adds = job.additions.filter((a) => a.status !== "dropped").length;
  log(`         ${["keep", "bind", "rewrite", "drop", "review"].filter((k) => counts[k]).map((k) => ACTION_COLOR[k]!(`${k.toUpperCase()} ${counts[k]}`)).join("  ")}${adds ? c.blue(`  + ${adds} addition`) : ""}`);
  log();
  const blocks = new Map(job.blocks.map((b) => [b.id, b]));
  for (const d of job.decisions) {
    if (d.action === "keep" && !full) continue;
    if (d.action === "keep" && full && d.origin !== "user") continue;
    const b = blocks.get(d.blockId)!;
    const tag = ACTION_COLOR[d.action]!(d.action.toUpperCase().padEnd(7));
    const ev = d.evidence.map((e) => `${e.ref} ${e.state}`).join(", ");
    log(`  ${tag} ${c.dim(d.blockId)} ${oneLine(b.text, 40).padEnd(40)} ${c.dim(d.reason)}${d.origin === "carried" ? c.dim(" · carried") : ""}`);
    if (ev) log(`          ${c.dim(`↳ evidence: ${oneLine(ev, 90)}`)}`);
    if (d.action === "review") {
      for (const f of d.flags) log(`          ${c.yellow("↳")} ${safePrint(f)}`);
      if (d.proposed) log(`          ${c.dim(`proposal: ${d.proposed.action} — ${oneLine(d.proposed.text || "(remove)", 90)}`)}`);
      if (full) {
        log(c.dim(indent(safePrint(b.text), 12)));
        if (d.proposed?.text) { log(c.dim("            ── proposed ──")); log(c.blue(indent(safePrint(d.proposed.text), 12))); }
      }
    } else if (full && (d.action === "bind" || d.action === "rewrite")) {
      log(c.blue(indent(safePrint(d.text), 12)));
    }
  }
  if (job.behavior) {
    const tag = job.behavior.decision === "pending" ? c.yellow("REVIEW ") : c.dim(job.behavior.decision.toUpperCase().padEnd(7));
    log(`  ${tag} ${c.dim("fm")}  frontmatter fields that change agent behaviour: ${job.behavior.fields.join(", ")}`);
    if (job.behavior.decision === "pending") log(`          ${c.yellow("↳")} keep them as upstream wrote them, or drop them`);
  }
  for (const w of job.warnings ?? []) log(`  ${c.yellow("WARN   ")} ${safePrint(w)}`);
  for (const a of job.additions.filter((x) => x.status !== "dropped")) {
    log(`  ${c.blue("ADD    ")} ${c.dim(a.id)} after ${a.after}: ${oneLine(a.text, 60)}${a.status === "review" ? c.yellow("  needs review") : ""}`);
    if (a.status === "review") for (const f of a.flags) log(`          ${c.yellow("↳")} ${safePrint(f)}`);
  }
  log();
  if (job.state === "needs-review") {
    const ids = [...job.decisions.filter((d) => d.action === "review").map((d) => d.blockId), ...job.additions.filter((a) => a.status === "review").map((a) => a.id), ...(job.behavior?.decision === "pending" ? ["fm"] : [])];
    log(`${c.yellow("next")}  skilladopt review ${job.id} --decide ${ids.map((i) => `${i}=keep|drop${job.decisions.find((d) => d.blockId === i)?.proposed ? "|accept" : ""}`).join(" --decide ")}`);
  } else if (job.state === "ready") {
    log(`${c.green("next")}  skilladopt apply ${job.id}${licenseAllowsCommit(job) ? "" : " --private"}   ${c.dim(`→ ${job.targets.join(", ")}`)}`);
  }
}

function indent(s: string, n: number): string {
  return s.split("\n").map((l) => " ".repeat(n) + l).join("\n");
}

// ---------------------------------------------------------------- main

async function main(argv: string[]): Promise<number> {
  // Help and version are answered before option parsing, so they always work.
  if (!argv.length && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) return offerSetup();
  if (!argv.length || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) { log(HELP); return 0; }
  if (argv[0] === "version" || argv.includes("--version") || argv.includes("-v")) { log(VERSION); return 0; }
  const opts = parseArgs(argv);
  const cmd = opts._[0];
  if (cmd === "setup") return cmdSetup(opts);
  const root = findRoot(opts.cwd ?? process.cwd());
  if (cmd === "doctor") {
    const kind = (opts.worker ?? detectWorker()) as WorkerKind;
    if (kind !== "codex" && kind !== "claude") throw new UserError("doctor needs --worker codex or claude (or one of them on PATH)");
    log(c.bold(`skilladopt doctor · ${kind}`));
    const { status, lines } = await doctor(kind, opts.model);
    for (const l of lines) log(`  ${l.startsWith("PASS") ? c.green(l) : l.startsWith("FAIL") ? c.red(l) : l.startsWith("INCONCLUSIVE") ? c.yellow(l) : c.dim(l)}`);
    if (status === "pass") log(c.green("no canary leaked and every probe was refused. This is a probe on this machine, not a guarantee."));
    else if (status === "inconclusive") log(c.yellow("inconclusive: no canary leaked, but the worker did not show that every probe was refused."));
    else log(c.red("a canary leaked: do not use this worker for untrusted skills."));
    return status === "pass" ? 0 : 1;
  }
  if (cmd === "recover") {
    const done = recover(root);
    log(done ?? "Nothing to recover.");
    return 0;
  }
  const pending = pendingJournal(root);
  if (pending && cmd !== "apply") log(c.yellow(`note: an earlier apply was interrupted (${pending}). Run \`skilladopt recover\` to roll it back.`));
  const COMMANDS = ["add", "update", "review", "apply", "impact", "check", "status", "ls"];
  if (!COMMANDS.includes(cmd ?? "")) opts._.unshift("add"); // `skilladopt owner/repo skill` is the same as `skilladopt add owner/repo skill`
  switch (opts._[0]) {
    case "add": return cmdAdd(opts, root);
    case "update": return cmdUpdate(opts, root);
    case "review": return cmdReview(opts, root);
    case "apply": return cmdApply(opts, root);
    case "impact": case "check": return cmdImpact(opts, root);
    case "status": case "ls": return cmdStatus(opts, root);
    default: throw new UserError(`Unknown command. Run skilladopt --help.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UserError) process.stderr.write(`${c.red("error")} ${e.message}\n`);
    else process.stderr.write(`${c.red("unexpected error")} ${e?.stack ?? e}\n`);
    process.exit(2);
  },
);

