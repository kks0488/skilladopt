<div align="center">

# skilladopt

**Don't install agent skills. Adopt them.**

[![npm](https://img.shields.io/npm/v/skilladopt?color=7ee2a8)](https://www.npmjs.com/package/skilladopt)
[![ci](https://github.com/kks0488/skilladopt/actions/workflows/ci.yml/badge.svg)](https://github.com/kks0488/skilladopt/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-b9a2f0)](LICENSE)

[English](README.md) · [한국어](README.ko.md)

![What skilladopt does, in 20 seconds](assets/explainer.gif)

</div>

Skills you find on GitHub for Claude Code or Codex were written for **someone else's** project.
skilladopt rewrites a skill for **yours**, notes why each line changed, and later tells you
exactly what to re-check when your project changes.

## Quick start

```bash
npx skilladopt add anthropics/skills frontend-design
```

That's a GitHub repo and the name of a skill in it. You can also paste a GitHub link.
skilladopt shows what it kept, changed or dropped. When it looks right:

```bash
npx skilladopt apply last
```

Needs Node 20+ and [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) on your machine.

## What you get

- **Lines that don't fit your project are dropped**, with the reason ("you don't use Tailwind").
- **Generic steps become your real commands**: "run the tests" → `npm test`.
- **Your own rules win**: a skill that says "delete unused files" learns about your "never delete docs/".
- **Later, one command shows what to re-check**: `npx skilladopt impact` → "1 of 25 decisions need a re-check".
- **It says no** when a skill doesn't fit at all, and anything it can't verify waits for you.

## See it run

![skilladopt in a terminal: adopt a skill, then a teammate changes the test script and adds a rule, and impact points at exactly what to re-check](assets/demo.gif)

<sub>Real run with the Codex worker; the ~40 s while it reads the skill is cut. Recorded from <a href="assets/demo.tape">assets/demo.tape</a>.</sub>

## Commands

| Command | What it does |
|---|---|
| `skilladopt add <repo> [skill]` | Read a skill and fit it to this project |
| `skilladopt review <job>` | Decide anything it could not verify (`--decide b12=keep\|drop\|accept`) |
| `skilladopt apply <job>` | Install it into `.agents/skills` (Codex) and `.claude/skills` (Claude Code) |
| `skilladopt impact` | What changed in your project that affects adopted skills (`--upstream` checks the original too) |
| `skilladopt update <name>` | Re-fit to the latest version of the original; unchanged decisions are reused |
| `skilladopt status` | Adopted skills and hand edits |
| `skilladopt doctor` | Check that the AI worker is really isolated on your machine |

`<job>` can be `last`. To use it from inside your agent, add the [skilladopt agent skill](skill/skilladopt/SKILL.md).

<details>
<summary><b>How it decides</b></summary>

Each paragraph of the skill gets one decision, and every non-trivial decision cites evidence from your project (a dependency, an npm script, an `AGENTS.md` line):

| Decision | Meaning | Checked by code |
|---|---|---|
| `keep` | stays as written | — |
| `bind` | a generic command becomes yours | only one command or path may be inserted, the rest of the sentence must be identical, and it must exist in your project |
| `rewrite` | the intent applies, the details don't | always shown to you before install |
| `drop` | doesn't apply here | "stack mismatch" must point at something actually absent; conflicts must cite the exact `AGENTS.md` line |
| `review` | the AI was unsure | you decide |

Paragraphs with a duty (a prohibition, an approval, a verification step) are never dropped or rewritten without you.
`impact` re-checks decisions that recorded evidence and lists instruction lines added since adoption; general advice kept as-is has nothing to re-check.
</details>

<details>
<summary><b>Safety</b></summary>

- Nothing from a skill is executed. Files are read through the GitHub API at a pinned commit.
- Refused before any AI sees it: hidden Unicode, control characters, symlinks, path tricks, skills that need scripts.
- The AI worker only gets the skill text and a short summary of your project. `claude` runs with `--safe-mode` and no tools; `codex` runs in a read-only sandbox without network tools or access to your home folder. `skilladopt doctor` probes this on your machine (a probe, not a proof).
- The worker's answer is checked by code: missing decisions, fake evidence, removed duties, inserted commands, new links, secrets and hidden comments are caught.
- Installs are transactional and never overwrite folders you edited by hand (unless `--force`).
- Adapted copies keep the original license and notice. Skills without a recognised permissive license need `--private`, which keeps them out of git.
</details>

<details>
<summary><b>Files it writes</b></summary>

```
.agents/skills/<name>/      the adopted skill for Codex (+ NOTICE.md)
.claude/skills/<name>/      the same for Claude Code     (--target codex|claude|both)
.skilladopt/lock.json       source, pinned commit, hashes
.skilladopt/decisions/      every decision and its evidence
.skilladopt/upstream/       the original as adopted
.skilladopt/approved/       exactly what you approved
```
</details>

<details>
<summary><b>Limits (v0.1)</b></summary>

- Markdown skills only; skills that need scripts are refused. Shared Markdown docs a skill links to in the same repository are bundled (one level, never other skills).
- Only the first 400 lines of your instruction files are shown to the AI (you get a note).
- "Saves you time" is not measured yet. Early users welcome: open an issue with what worked and what didn't.
- Tested with Codex CLI 0.161 and Claude Code 2.1 on macOS; tests run on Linux with Node 20 and 24.
</details>

## Prior art

Adapting skills with a personal prompt is not new: see `/skillify` in [makerskills](https://github.com/coreyhaines31/makerskills) and skillsmith's `upstream-review`; [rulesync](https://github.com/dyoshikawa/rulesync) and [agents-lint](https://github.com/giacomo/agents-lint) solve neighbouring problems. skilladopt focuses on evidence for every decision and on knowing which ones a change invalidated.

MIT License
