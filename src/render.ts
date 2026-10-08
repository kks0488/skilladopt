import { posix } from "node:path";
import { parseFrontmatter } from "./blocks.js";
import { INFO_FIELDS, type Job } from "./job.js";
import { scanInput } from "./scan.js";
import { PERMISSIVE } from "./source.js";
import { sha256, stableStringify, UserError, VERSION } from "./util.js";

const REWRITTEN_FIELDS = new Set(["name", "description", "license", "metadata"]);

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/**
 * Build the adopted skill files from the job. Pure and deterministic: the same job gives the same bytes.
 * Returns relative path -> content (relative to the skill directory).
 */
export function render(job: Job): Record<string, string> {
  const pending = job.decisions.filter((d) => d.action === "review").map((d) => d.blockId);
  if (job.behavior?.decision === "pending") pending.push("fm");
  if (pending.length) throw new UserError(`Undecided blocks: ${pending.join(", ")}. Run \`skilladopt review ${job.id}\`.`);
  const decision = new Map(job.decisions.map((d) => [d.blockId, d]));
  const out: Record<string, string> = {};
  const mdFiles = job.files.filter((f) => /\.md$/i.test(f.path) && !/^(LICENSE|LICENCE|NOTICE|COPYING)/i.test(f.path.split("/").pop()!));

  for (const file of mdFiles) {
    const parts: string[] = [];
    for (const b of job.blocks.filter((x) => x.file === file.path)) {
      const d = decision.get(b.id);
      if (!d) throw new UserError(`No decision for ${b.id}`);
      if (d.action === "keep") parts.push(b.text);
      else if (d.action === "bind" || d.action === "rewrite") parts.push(d.text);
      for (const a of job.additions) if (a.after === b.id && a.status === "ok") parts.push(a.text);
    }
    if (file.path === "SKILL.md") {
      // Fields that change how agents load or run the skill (allowed-tools, disable-model-invocation, …)
      // are carried over verbatim. Only identity fields are rewritten.
      const dropBehavior = job.behavior?.decision === "drop";
      const preserved = parseFrontmatter(file.content)
        .entries.filter((e) => !REWRITTEN_FIELDS.has(e.key) && !(dropBehavior && !INFO_FIELDS.has(e.key)))
        .map((e) => e.raw);
      const fm = [
        "---",
        `name: ${job.skill.name}`,
        `description: ${yamlString(job.skill.description)}`,
        ...preserved,
        ...(job.license ? [`license: ${yamlString(job.license.spdx === "UNKNOWN" ? "See NOTICE.md" : `${job.license.spdx} (see NOTICE.md)`)}`] : []),
        "metadata:",
        `  adopted-from: ${yamlString(job.source.id)}`,
        `  adopted-commit: ${yamlString(job.source.commit ?? "")}`,
        `  adopted-by: ${yamlString(`skilladopt ${VERSION}`)}`,
        "---",
        "",
      ].join("\n");
      out[file.path] = fm + parts.join("\n\n") + "\n";
    } else if (parts.length) {
      const original = parseFrontmatter(file.content);
      out[file.path] = (original.raw !== null ? `---\n${original.raw}\n---\n\n` : "") + parts.join("\n\n") + "\n";
    }
  }
  out["NOTICE.md"] = notice(job);
  // Last line of defence: nothing secret-looking or hidden ships in any generated file.
  for (const [path, content] of Object.entries(out)) {
    const bad = scanInput(content).filter((f) => f.level === "reject" || f.code === "secret-value");
    if (bad.length) throw new UserError(`${path} would contain ${bad.map((f) => f.message).join(", ")}; refusing to build it.`);
  }
  return out;
}

function notice(job: Job): string {
  const lines = [
    "# Notice",
    "",
    "This skill was adapted for this project by [skilladopt](https://github.com/kks0488/skilladopt).",
    "It is a modified version of the original. Every change and the evidence behind it is recorded in",
    `\`.skilladopt/decisions/${job.skill.name}.json\`.`,
    "",
    `- Original: ${job.source.url ?? job.source.id}`,
    `- Original commit: ${job.source.commit ?? "n/a"}`,
    `- License: ${job.license?.spdx ?? "not found"}`,
  ];
  if (job.license?.text) {
    lines.push("", "## Original license", "", fence(job.license.text.trim()));
  }
  for (const f of job.files.filter((x) => /^NOTICE(\.(md|txt))?$/i.test(x.path))) {
    lines.push("", `## Original ${f.path}`, "", fence(f.content.trim()));
  }
  return lines.join("\n") + "\n";
}

/** A code fence longer than any backtick run inside, so the quoted text cannot break out. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
}

/** Local links in the rendered skill that point at files no longer shipped. */
export function danglingReferences(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!/\.md$/i.test(path) || path === "NOTICE.md") continue;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    for (const m of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!.split("#")[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const resolved = posix.normalize(dir + target);
      if (!(resolved in files)) out.push(`${path} links to ${target}, which is not part of the adopted skill`);
    }
  }
  return out;
}

export function licenseAllowsCommit(job: Job): boolean {
  return !!job.license && PERMISSIVE.has(job.license.spdx);
}

/** Seal everything that determines the installed bytes. */
export function manifestOf(job: Job, files: Record<string, string>): string {
  return sha256(
    stableStringify({
      tool: VERSION,
      source: { id: job.source.id, commit: job.source.commit, files: job.files.map((f) => [f.path, f.hash]) },
      project: job.projectHash,
      targets: job.targets,
      output: Object.entries(files).map(([p, c]) => [p, sha256(c)]).sort(),
    }),
  ).slice(0, 16);
}
