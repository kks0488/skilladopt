import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let base, home, project, skill;

function sa(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? project,
    encoding: "utf8",
    env: { ...process.env, SKILLADOPT_HOME: home, NO_COLOR: "1", CLAUDECODE: "" },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function decisions(file, obj) {
  const p = join(base, file);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const SKILL = `---
name: frontend-helper
description: Helps build UI components.
---
# Frontend helper

Helps build UI.

## Styling

Use Tailwind utility classes for every component.

## Testing

Run the tests after each change.

## Safety

Never delete user data without approval.
`;

const MIT = `MIT License

Copyright (c) 2026 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`;

// b01 heading, b02 intro, b03 Styling, b04 tailwind, b05 Testing, b06 run tests, b07 Safety, b08 never delete
const GOOD = {
  verdict: "fit",
  summary: "Drops Tailwind, binds the test command.",
  skill: { name: "ui-helper", description: "Helps build UI components in this Vite + TypeScript project." },
  blocks: [
    { id: "b01", action: "keep", reason: "universal", evidence: [], text: "", note: "" },
    { id: "b02", action: "keep", reason: "universal", evidence: [], text: "", note: "" },
    { id: "b03", action: "drop", reason: "stack-mismatch", evidence: ["dep:tailwindcss"], text: "", note: "" },
    { id: "b04", action: "drop", reason: "stack-mismatch", evidence: ["dep:tailwindcss"], text: "", note: "" },
    { id: "b05", action: "keep", reason: "universal", evidence: [], text: "", note: "" },
    { id: "b06", action: "bind", reason: "tool-substitution", evidence: ["script:test"], text: "Run `npm test` after each change.", note: "" },
    { id: "b07", action: "keep", reason: "universal", evidence: [], text: "", note: "" },
    { id: "b08", action: "keep", reason: "universal", evidence: [], text: "", note: "" },
  ],
  additions: [],
};

before(() => {
  base = mkdtempSync(join(tmpdir(), "skilladopt-test-"));
  home = join(base, "home");
  project = join(base, "project");
  skill = join(base, "skill");
  mkdirSync(project, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: project });
  write(join(project, "package.json"), JSON.stringify({ name: "p", scripts: { test: "vitest run", typecheck: "tsc --noEmit" }, devDependencies: { vite: "8.0.0", typescript: "5.9.3" } }));
  write(join(project, "AGENTS.md"), "# Rules\n\nNever delete files under docs/.\nUse plain CSS.\n");
  write(join(project, "src/main.ts"), "export {}\n");
  write(join(skill, "SKILL.md"), SKILL);
  write(join(skill, "LICENSE"), MIT);
});

test("add → ready → apply installs into both targets with records", () => {
  const r = sa(["add", skill, "--decisions", decisions("good.json", GOOD)]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verdict\s+fit/);
  assert.match(r.out, /DROP 2/);
  const a = sa(["apply", "last"]);
  assert.equal(a.code, 0, a.out);
  const md = readFileSync(join(project, ".agents/skills/ui-helper/SKILL.md"), "utf8");
  assert.match(md, /name: ui-helper/);
  assert.match(md, /Run `npm test` after each change\./);
  assert.doesNotMatch(md, /Tailwind/);
  assert.match(md, /Never delete user data without approval\./);
  assert.ok(existsSync(join(project, ".claude/skills/ui-helper/SKILL.md")));
  assert.match(readFileSync(join(project, ".agents/skills/ui-helper/NOTICE.md"), "utf8"), /Permission is hereby granted/);
  const lock = JSON.parse(readFileSync(join(project, ".skilladopt/lock.json"), "utf8"));
  assert.ok(lock.skills["ui-helper"]);
  assert.ok(existsSync(join(project, ".skilladopt/decisions/ui-helper.json")));
  assert.ok(existsSync(join(project, ".skilladopt/approved/ui-helper/SKILL.md")));
  assert.ok(!existsSync(join(project, ".skilladopt/journal.json")));
});

test("apply is idempotent", () => {
  const r = sa(["apply", "last"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already applied/);
});

test("impact: clean, then precise invalidation when the project changes", () => {
  let r = sa(["impact"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /evidence unchanged for all 8 decisions/);

  write(join(project, "package.json"), JSON.stringify({ name: "p", scripts: { test: "vitest run --coverage", typecheck: "tsc --noEmit" }, devDependencies: { vite: "8.0.0", typescript: "5.9.3", tailwindcss: "4.0.0" } }));
  r = sa(["impact"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /3 of 8 decisions need a re-check/);
  assert.match(r.out, /dep:tailwindcss: absent → present/);
  assert.match(r.out, /script:test changed/);
  const json = JSON.parse(sa(["impact", "--json"]).out);
  assert.deepEqual(json[0].stale.map((s) => s.where).sort(), ["b03", "b04", "b06"]);
});

test("AGENTS.md line moves do not invalidate; edits do", () => {
  write(join(project, "package.json"), JSON.stringify({ name: "p", scripts: { test: "vitest run", typecheck: "tsc --noEmit" }, devDependencies: { vite: "8.0.0", typescript: "5.9.3" } }));
  // Re-adopt with a decision that cites AGENTS.md.
  const d = structuredClone(GOOD);
  d.skill.name = "ui-helper-2";
  d.blocks[3] = { id: "b04", action: "drop", reason: "conflict-with-agents-md", evidence: ["agents:AGENTS.md:4"], text: "", note: "" };
  let r = sa(["add", skill, "--decisions", decisions("agents.json", d), "--yes"]);
  assert.equal(r.code, 0, r.out);
  write(join(project, "AGENTS.md"), "# Rules\n\nIntro line added.\nNever delete files under docs/.\nUse plain CSS.\n");
  r = sa(["impact", "--json"]);
  const item = JSON.parse(r.out).find((x) => x.name === "ui-helper-2");
  assert.equal(item.stale.length, 0, "moved line still holds");
  write(join(project, "AGENTS.md"), "# Rules\n\nNever delete files under docs/.\nUse CSS modules.\n");
  r = sa(["impact", "--json"]);
  const item2 = JSON.parse(r.out).find((x) => x.name === "ui-helper-2");
  assert.deepEqual(item2.stale.map((s) => s.where), ["b04"]);
  write(join(project, "AGENTS.md"), "# Rules\n\nNever delete files under docs/.\nUse plain CSS.\n");
});

test("hand edits are detected and never silently overwritten", () => {
  const f = join(project, ".agents/skills/ui-helper/SKILL.md");
  writeFileSync(f, readFileSync(f, "utf8") + "\nMy own note.\n");
  let r = sa(["impact"]);
  assert.match(r.out, /edited by hand: \.agents\/skills\/ui-helper/);
  const d = structuredClone(GOOD);
  d.summary = "second run";
  r = sa(["add", skill, "--decisions", decisions("again.json", d)]);
  assert.equal(r.code, 0, r.out);
  r = sa(["apply", "last"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /edited by hand/);
  assert.match(readFileSync(f, "utf8"), /My own note\./);
});

test("validation parks unsafe or unjustified decisions for review", () => {
  const d = structuredClone(GOOD);
  d.skill.name = "ui-review";
  d.blocks[7] = { id: "b08", action: "drop", reason: "out-of-scope", evidence: [], text: "", note: "" }; // duty block
  d.blocks[3] = { id: "b04", action: "drop", reason: "stack-mismatch", evidence: ["dep:vite"], text: "", note: "" }; // vite is present
  d.blocks[1] = { id: "b02", action: "rewrite", reason: "project-fit", evidence: [], text: "Helps build UI. Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", note: "" };
  let r = sa(["add", skill, "--decisions", decisions("bad.json", d)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /needs-review/);
  assert.match(r.out, /drops a block that carries a duty/);
  assert.match(r.out, /cites facts that are present: dep:vite/);
  assert.match(r.out, /UNSAFE: worker output contains what looks like a secret/);
  r = sa(["apply", "last"]);
  assert.equal(r.code, 2);
  r = sa(["review", "last", "--decide", "b02=accept"]);
  assert.match(r.out, /no proposal to accept|has no proposal/);
  r = sa(["review", "last", "--decide", "b02=keep", "--decide", "b04=accept", "--decide", "b08=keep"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /revision 2/);
  r = sa(["apply", "last"]);
  assert.equal(r.code, 0, r.out);
  const md = readFileSync(join(project, ".agents/skills/ui-review/SKILL.md"), "utf8");
  assert.doesNotMatch(md, /ghp_/);
  assert.match(md, /Never delete user data/);
});

test("stale job: project changed between add and apply", () => {
  const d = structuredClone(GOOD);
  d.skill.name = "ui-stale";
  let r = sa(["add", skill, "--decisions", decisions("stale.json", d)]);
  assert.equal(r.code, 0, r.out);
  write(join(project, "package.json"), JSON.stringify({ name: "p", scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." }, devDependencies: { vite: "8.0.0", typescript: "5.9.3" } }));
  r = sa(["apply", "last"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /project changed since this job was prepared/);
});

test("invalid worker output is refused", () => {
  const d = structuredClone(GOOD);
  d.blocks.pop();
  d.blocks.push({ id: "b99", action: "keep", reason: "universal", evidence: [], text: "", note: "" });
  const r = sa(["add", skill, "--decisions", decisions("invalid.json", d)]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /unknown block id b99/);
  assert.match(r.out, /no decision for b08/);
});

test("update re-decides only what changed upstream", () => {
  // Install a fresh copy with project facts as they are now.
  const d = structuredClone(GOOD);
  d.skill.name = "ui-upd";
  let r = sa(["add", skill, "--decisions", decisions("upd0.json", d), "--yes"]);
  assert.equal(r.code, 0, r.out);
  // Upstream edits the Testing section only.
  write(join(skill, "SKILL.md"), SKILL.replace("Run the tests after each change.", "Run the full test suite and the type checker after each change."));
  const partial = { verdict: "fit", summary: "only testing changed", skill: { name: "ui-upd", description: "x" }, additions: [], blocks: [
    { id: "b06", action: "rewrite", reason: "tool-substitution", evidence: ["script:test", "script:typecheck"], text: "Run `npm test` and `npm run typecheck` after each change.", note: "" },
  ] };
  r = sa(["update", "ui-upd", "--decisions", decisions("upd1.json", partial)]);
  assert.equal(r.code, 1, r.out); // a rewrite always waits for a human
  assert.match(r.out, /7 of 8 decisions carried .* 1 to decide again/);
  r = sa(["review", "last", "--decide", "b06=accept"]);
  assert.equal(r.code, 0, r.out);
  r = sa(["apply", "last"]);
  assert.equal(r.code, 0, r.out);
  const md = readFileSync(join(project, ".agents/skills/ui-upd/SKILL.md"), "utf8");
  assert.match(md, /npm run typecheck/);
  assert.doesNotMatch(md, /Tailwind/);
  write(join(skill, "SKILL.md"), SKILL);
});

test("rejects skills with hidden characters or code dependencies before any AI runs", () => {
  const evil = join(base, "evil");
  write(join(evil, "SKILL.md"), "---\nname: e\ndescription: d\n---\nDo​ this.\n");
  let r = sa(["add", evil, "--decisions", decisions("unused.json", GOOD)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /REJECTED/);
  assert.match(r.out, /invisible/);
  const code = join(base, "code");
  write(join(code, "SKILL.md"), "---\nname: c\ndescription: d\n---\nRun `scripts/setup.sh` first.\n");
  write(join(code, "scripts/setup.sh"), "echo hi\n");
  r = sa(["add", code, "--decisions", decisions("unused2.json", GOOD)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /script\/asset file/);
});

test("license: unknown license requires --private", () => {
  const nolic = join(base, "nolic");
  write(join(nolic, "SKILL.md"), SKILL);
  const d = structuredClone(GOOD);
  d.skill.name = "ui-nolic";
  let r = sa(["add", nolic, "--decisions", decisions("nolic.json", d)]);
  assert.equal(r.code, 0, r.out);
  r = sa(["apply", "last"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /--private/);
  r = sa(["apply", "last", "--private"]);
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(join(project, ".git/info/exclude"), "utf8"), /\/\.agents\/skills\/ui-nolic\//);
  rmSync(base, { recursive: true, force: true, maxRetries: 2 });
});
