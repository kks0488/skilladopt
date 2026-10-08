# skilladopt

> **Don't install agent skills. Adopt them.**

[한국어](README.ko.md)

Agent skills (`SKILL.md`) are written for someone else's project. Drop a popular one into yours and
your coding agent starts following the author's stack, the author's commands and the author's habits.

`skilladopt` fits a third-party skill to **your** codebase, records **why** every part was kept,
changed or dropped, and later tells you **exactly which of those decisions** a change in your project
or in the original skill has invalidated.

```bash
npx skilladopt add DietrichGebert/ponytail/.openclaw/skills/ponytail
```

> v0.1 is experimental. It works on instruction-only skills (Markdown). Skills that ship scripts are refused for now.

## The problem

- A frontend skill says "use Tailwind utility classes". Your project uses plain CSS. Your agent starts adding Tailwind.
- A skill says "run the tests". Which command? It doesn't know your scripts.
- A skill says "delete files you don't need". Your `AGENTS.md` says "never delete docs/". Which one wins?
- You fix all of that by hand. Next month the original skill improves, or your project changes. You start over.

Several people already solve the first part by hand or with a personal "adapt this skill" prompt.
skilladopt is a tool for the whole lifecycle: **adapt → record evidence → notice what went stale**.

## How it works

```
skilladopt add <skill>       fetch (pinned commit) → safety checks → read your project
                             → an isolated AI worker proposes a decision per paragraph
                             → code validates every decision → preview
skilladopt review <job>      you decide anything the code could not verify
skilladopt apply <job>       transactional install into .agents/skills and .claude/skills
skilladopt impact            which decisions lost their evidence? (no AI, CI friendly)
skilladopt update <name>     re-fit to the latest upstream; unchanged decisions are reused
skilladopt doctor            probe the worker's isolation on your machine
```

Each paragraph of the skill gets one decision, and every non-trivial decision cites evidence from your project:

| Decision | Meaning | Checked by code |
|---|---|---|
| `keep` | stays verbatim | — |
| `bind` | a generic command becomes yours ("run the tests" → `` `npm test` ``) | only one short stretch may change, and only into commands/paths that exist in your project; the rest of the sentence must be identical; no duty or negation may be touched. The code records the command as evidence |
| `rewrite` | the intent applies, the specifics don't | **always shown to you before install** |
| `drop` | doesn't apply here | `stack-mismatch` must cite something actually absent (e.g. `dep:tailwindcss`); conflicts must cite the exact `AGENTS.md` line |
| `review` | the worker was unsure | you decide |

Paragraphs that carry a duty (a prohibition, an approval, a verification step) can never be dropped or rewritten without you.

## Example

```
$ skilladopt add DietrichGebert/ponytail/.openclaw/skills/ponytail
source   github:DietrichGebert/ponytail/.openclaw/skills/ponytail @ b088b2d · MIT
project  npm · html, typescript, css · 4 deps · 5 scripts · AGENTS.md
worker   codex · read-only sandbox, no network tools, no home dir · 25 block(s) to decide

verdict  needs-review
skill    ponytail — Lazy senior dev mode for coding tasks in star-tactics, a TypeScript canvas game …
         KEEP 22  REVIEW 3

  REVIEW  b11 4. An installed dependency? Use it. Nev… project-fit
          ↳ evidence: agents:AGENTS.md:5 present
          ↳ rewrites a block that carries a duty (prohibition / approval / verification)
            4. An installed dependency? Use it. Never add a dependency for a few lines.
            ── proposed ──
            4. An installed dependency? Use it. Never add a dependency for a few lines.
               Never add any new dependency without asking the user first.
  REVIEW  b21 - Lazy code without its check is unfini… project-fit
          ↳ evidence: agents:AGENTS.md:6 present, script:test present, script:typecheck present
            ── proposed ──
            … Before saying a task is done, run `npm test` and `npm run typecheck`.

$ skilladopt review last --decide all=accept
$ skilladopt apply last
✓ adopted ponytail → .agents/skills/ponytail, .claude/skills/ponytail
```

A week later a teammate relaxes the dependency rule in `AGENTS.md` and changes the test script:

```
$ skilladopt impact
ponytail  2 of 25 decisions need a re-check · 23 unaffected
  ↻ b11  rewrite  agents:AGENTS.md:5 now says "- New dependencies are fine if they are under 50kb gzipped."
  ↻ b21  rewrite  script:test changed: `vitest run` → `vitest run --coverage`
```

Not "re-read the whole skill": **these two paragraphs, and why.** `impact` runs offline and exits non-zero, so it works as a CI check.

`impact` re-checks the decisions that recorded evidence (a script, a dependency, an `AGENTS.md` line). Paragraphs kept as general advice have no evidence and are not re-checked. "Unaffected" means "nothing they were based on changed", not "still perfect". When a new line appears in your instruction files, `impact` lists it, and `update` then decides every paragraph again.

## Install

Node 20+. The worker that reads the skill is whichever coding agent you already use: `codex` or `claude` on your `PATH`.

```bash
npx skilladopt add <github-url | owner/repo/path | ./local/dir>
```

There is also an agent skill in [`skill/skilladopt`](skill/skilladopt/SKILL.md). Copy it into your agent's skills folder and you can say "adopt this skill: <url>".

## Safety model (and its limits)

- **Fetched content is data.** Nothing from the skill is executed. Files are read through the GitHub API at a pinned commit, not unpacked from archives.
- **Refused before any AI sees it:** hidden/bidirectional Unicode, control characters, symlinks, path traversal, skills that need scripts, or files outside their folder that are not shared Markdown docs from the same repository.
- **The worker is isolated.** It only gets the skill text and a summary of your project (dependency names, npm scripts, `AGENTS.md` lines) in its prompt.
  - `claude`: `--safe-mode` (no CLAUDE.md, skills, plugins, hooks or MCP), no tools.
  - `codex`: read-only sandbox, network disabled for its tools, no access to your home directory.
  - Both talk to their own model API, of course.
- **Check it yourself:** `skilladopt doctor` asks the worker to read a canary file in your home directory, read an environment variable it should not get, and write a file, and fails if any canary comes back.
- **The worker is not trusted.** Its answer is validated by code: unknown blocks, missing decisions, fake evidence, removed duties, inserted commands, new URLs, secrets and hidden comments are caught.
- **Static checks are tripwires, not proof.** A clean scan means nothing obvious was found.
- **Installs are transactional.** Hand-edited or unmanaged folders are never overwritten without `--force`, and paths are never written through symlinks.
- **Licenses.** Adapted copies keep the original license and notice. Only recognised permissive licenses are installed normally. Anything else needs `--private`, which keeps the copy and its records out of git.

## What it writes

```
.agents/skills/<name>/      the adopted skill for Codex (+ NOTICE.md)
.claude/skills/<name>/      the same for Claude Code       (--target codex|claude|both)
.skilladopt/lock.json       source, pinned commit, hashes
.skilladopt/decisions/      every decision and its evidence
.skilladopt/upstream/       the original as adopted (kept to restore and compare later)
.skilladopt/approved/       exactly what you approved (kept to restore and compare later)
```

Transaction state (journal, backups, lock) lives in `~/.cache/skilladopt`, never in the repository, so a repository cannot plant one.

## Limits (v0.1)

- Markdown-only skills. Skills that need scripts are refused. Shared Markdown docs a skill links to outside its folder are bundled (same repository only, one level deep, never other skills); anything else outside the folder is refused.
- The Markdown splitter is line-based, not a full parser.
- Only the first 400 non-empty lines of your instruction files are shown to the worker (you get a note when that happens).
- `doctor` is a probe on your machine, not a proof of isolation; network access is reported by the worker, not verified.
- Evidence is about what the code can see: dependencies, npm/python manifests, files, `AGENTS.md`/`CLAUDE.md` lines. A decision with no evidence cannot be invalidated by `impact`.
- Tested with Codex CLI 0.161 and Claude Code 2.1 on macOS; the test suite runs on Linux with Node 20 and 24.

## Prior art

Adapting skills by hand or with a personal prompt is not new: see `/skillify` ADAPT in
[makerskills](https://github.com/coreyhaines31/makerskills), skillsmith's `upstream-review`, and
[rulesync](https://github.com/dyoshikawa/rulesync) / [agents-lint](https://github.com/giacomo/agents-lint)
for neighbouring problems. skilladopt's focus is evidence-linked decisions and knowing which ones a change invalidated.

## License

MIT
