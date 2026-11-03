import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const SKILL = "---\nname: helper\ndescription: Helps write clear prose.\n---\n# Helper\n\nWrite clear prose.\n";
const MIT = readFileSync(join(dirname(CLI), "../LICENSE"), "utf8");
const ANSWER = { verdict: "fit", summary: "Fits.", skill: { name: "helper", description: "Helps write clear prose." },
  blocks: ["b01", "b02"].map(id => ({ id, action: "keep", reason: "universal", evidence: [], text: "", note: "" })), additions: [] };

function snapshot(dir) {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    return lstatSync(path).isDirectory() ? [[name + "/", snapshot(path)]] : [[name, readFileSync(path).toString("base64")]];
  });
}

function fixture(t, answer = ANSWER) {
  const base = mkdtempSync(join(tmpdir(), "sa-preview-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, "project"), source = join(base, "source"), bin = join(base, "bin");
  for (const path of [project, source, bin]) mkdirSync(path);
  spawnSync("git", ["init", "-q"], { cwd: project });
  // Existing managed folders and an interrupted apply must also stay byte-for-byte intact.
  for (const folder of [".skilladopt", ".claude", ".agents"]) {
    mkdirSync(join(project, folder));
    writeFileSync(join(project, folder, "keep"), "existing content");
  }
  writeFileSync(join(project, ".skilladopt/journal.json"), "interrupted apply marker");
  writeFileSync(join(source, "SKILL.md"), SKILL);
  writeFileSync(join(source, "LICENSE"), MIT);
  const program = `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nlet prompt = '';\nfor await (const chunk of process.stdin) prompt += chunk;\nif (!prompt.includes('<upstream_skill>')) process.exit(7);\nconst result = ${JSON.stringify(answer)};\nconst output = args.indexOf('-o');\nif (output >= 0) fs.writeFileSync(args[output + 1], JSON.stringify(result));\nelse process.stdout.write(JSON.stringify({ structured_output: result }));\n`;
  for (const name of ["codex", "claude"]) {
    // Use CommonJS launcher so the stub runs without a package.json beside it.
    writeFileSync(join(bin, name), program.replace("import fs from 'node:fs';", "const fs = require('node:fs');").replace("let prompt = '';", "(async () => { let prompt = '';") + "\n})();\n", { mode: 0o755 });
  }
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, encoding: "utf8",
    env: { ...process.env, PATH: bin + ":" + process.env.PATH, SKILLADOPT_HOME: join(project, ".skilladopt/cache"), NO_COLOR: "1", ...env } });
  return { project, source, run };
}

for (const worker of ["codex", "claude"]) {
  for (const command of [[], ["add"]]) {
    test(`dry-run ${command[0] || 'default'} with ${worker} ignores --yes and writes no project files`, t => {
      const { project, source, run } = fixture(t);
      const before = snapshot(project);
      const r = run([...command, source, "--dry-run", "--json", "--worker", worker, "--yes", "--force", "--private"]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(r.stderr, "");
      assert.equal(r.stdout.trim().split("\n").length, 1);
      const data = JSON.parse(r.stdout);
      assert.equal(data.source, `local:${source}`);
      assert.match(data.commit, /^local-/);
      assert.equal(data.license, "MIT");
      assert.equal(data.verdict, "fit");
      assert.deepEqual(data.counts, { keep: 2, drop: 0, accept: 0, "needs-review": 0 });
      assert.deepEqual(data.changes, []);
      assert.deepEqual(data.rejectionReasons, []);
      assert.match(data.jobId, /^[0-9a-f]{8}$/);
      assert.deepEqual(snapshot(project), before);
    });
  }
}

test("script-dependent skill returns a refusal JSON without calling a worker or writing files", t => {
  const { project, source, run } = fixture(t);
  writeFileSync(join(source, "SKILL.md"), SKILL + "\nRun [helper](helper.py).\n");
  writeFileSync(join(source, "helper.py"), "raise Exception('must not execute')");
  const before = snapshot(project);
  const r = run(["add", source, "--dry-run", "--json", "--worker", "invalid"]);
  assert.equal(r.status, 1, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.verdict, "reject");
  assert.match(data.rejectionReasons.join(" "), /script|code/);
  assert.ok(data.source && data.jobId);
  assert.deepEqual(snapshot(project), before);
});

test("review counts and changes are bounded to five blocks", t => {
  const answer = { ...ANSWER, blocks: Array.from({ length: 8 }, (_, i) => ({
    id: `b${String(i + 1).padStart(2, '0')}`, action: "review", reason: "needs-human", evidence: [], text: "", note: "Check fit.",
  })) };
  const { project, source, run } = fixture(t, answer);
  writeFileSync(join(source, "SKILL.md"), SKILL + Array.from({ length: 6 }, (_, i) => `\nAdvice ${i}.\n`).join(""));
  const before = snapshot(project);
  const r = run([source, "--dry-run", "--json", "--worker", "codex"]);
  const data = JSON.parse(r.stdout);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(data.verdict, "needs-review");
  assert.equal(data.counts["needs-review"], 8);
  assert.equal(data.changes.length, 5);
  assert.deepEqual(Object.keys(data.changes[0]), ["block", "file", "action", "before", "after", "reason"]);
  assert.deepEqual(snapshot(project), before);
});

test("worker failure returns one JSON line and no project writes", t => {
  const { project, source, run } = fixture(t, {});
  const before = snapshot(project);
  const r = run([source, "--dry-run", "--json", "--worker", "codex"]);
  assert.equal(r.status, 2, r.stderr + r.stdout);
  const data = JSON.parse(r.stdout);
  assert.equal(data.verdict, "invalid");
  assert.ok(data.rejectionReasons.length);
  assert.deepEqual(snapshot(project), before);
});

test("--dry-run cannot be used to apply or recover a stored job", t => {
  const { project, run } = fixture(t);
  const before = snapshot(project);
  for (const command of ["apply", "recover", "setup", "update"]) {
    const r = run([command, "last", "--dry-run", "--yes"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /only supported for add/);
  }
  assert.deepEqual(snapshot(project), before);
});

test("dry-run counts validated bindings and drops", t => {
  const answer = { ...ANSWER, blocks: [
    ANSWER.blocks[0],
    { id: "b02", action: "bind", reason: "tool-substitution", evidence: ["script:test"], text: "Run `npm test`.", note: "Use the project test command." },
    { id: "b03", action: "drop", reason: "stack-mismatch", evidence: ["dep:tailwindcss"], text: "", note: "Tailwind is absent." },
  ] };
  const { project, source, run } = fixture(t, answer);
  writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(source, "SKILL.md"), SKILL.replace("Write clear prose.", "Run the tests.\n\nUse Tailwind for styling."));
  const before = snapshot(project);
  const r = run([source, "--dry-run", "--json", "--worker", "codex"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const data = JSON.parse(r.stdout);
  assert.deepEqual(data.counts, { keep: 1, drop: 1, accept: 1, "needs-review": 0 });
  assert.equal(data.changes[0].after, "Run `npm test`.");
  assert.deepEqual(snapshot(project), before);
});

test("TMPDIR inside the project cannot make dry-run write there", t => {
  const { project, source, run } = fixture(t);
  const before = snapshot(project);
  const r = run([source, "--dry-run", "--json", "--worker", "codex"], { TMPDIR: project });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(snapshot(project), before);
});

test("GitHub entry refusal retains the pinned source metadata", async t => {
  const { fetchGithub } = await import("../dist/source.js");
  const commit = "a".repeat(40);
  const calls = [];
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async url => {
    calls.push(url);
    const body = url.endsWith("/commits/main") ? { sha: commit } : { tree: [
      { path: "skills/helper/SKILL.md", mode: "100644", type: "blob", size: 50, sha: "b".repeat(40) },
      { path: "skills/helper/link.md", mode: "120000", type: "blob", size: 10, sha: "c".repeat(40) },
    ] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const source = await fetchGithub({ type: "github", owner: "org", repo: "skills", ref: "main", path: "skills/helper" });
  assert.equal(source.meta.id, "github:org/skills/skills/helper");
  assert.equal(source.meta.commit, commit);
  assert.ok(source.findings.some(f => f.level === "reject"));
  assert.equal(calls.length, 2); // No unsafe blob is downloaded.
});
