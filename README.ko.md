<div align="center">

# skilladopt

**AI 스킬, 그대로 설치하지 말고 입양하세요.**

[![npm](https://img.shields.io/npm/v/skilladopt?color=7ee2a8)](https://www.npmjs.com/package/skilladopt)
[![ci](https://github.com/kks0488/skilladopt/actions/workflows/ci.yml/badge.svg)](https://github.com/kks0488/skilladopt/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-b9a2f0)](LICENSE)

[English](README.md) · [한국어](README.ko.md)

![skilladopt가 하는 일 (20초)](assets/explainer.gif)

</div>

GitHub에서 찾은 Claude Code·Codex용 스킬은 **다른 사람의 프로젝트**를 기준으로 쓰여 있습니다.
skilladopt는 그 스킬을 **내 프로젝트**에 맞게 고치고, 줄마다 왜 바꿨는지 기록해 두었다가,
나중에 프로젝트가 바뀌면 다시 볼 곳만 정확히 알려 줍니다.

## 시작하기

```bash
npx skilladopt add anthropics/skills frontend-design
```

GitHub 저장소 이름과 그 안의 스킬 이름입니다. GitHub 링크를 그대로 붙여넣어도 됩니다.
무엇을 유지·변경·제외했는지 보여 주고, 괜찮으면 설치합니다.

```bash
npx skilladopt apply last
```

Node 20 이상과 [Claude Code](https://claude.com/claude-code) 또는 [Codex](https://github.com/openai/codex)가 설치돼 있어야 합니다.

## 얻는 것

- **내 프로젝트와 안 맞는 줄은 빠집니다.** 이유도 함께 남습니다("Tailwind를 쓰지 않음").
- **일반적인 지시가 내 실제 명령으로 바뀝니다**: "테스트를 돌려라" → `npm test`
- **내 규칙이 우선합니다**: "안 쓰는 파일은 지워라"라는 스킬이 "docs/는 절대 지우지 마라"라는 내 규칙을 따릅니다.
- **나중에 명령 하나로 다시 볼 곳을 압니다**: `npx skilladopt impact` → "25개 판단 중 1개만 다시 확인"
- **안 맞으면 거절합니다.** 확신할 수 없는 부분은 사람에게 묻습니다.

## 실제 동작

![터미널에서 스킬을 입양하고, 팀원이 테스트 명령을 바꾸고 규칙을 추가하자 impact가 다시 볼 곳을 짚는 장면](assets/demo.gif)

<sub>Codex 작업자로 실제 실행한 화면입니다. 스킬을 읽는 약 40초는 잘라냈습니다. 녹화 대본: <a href="assets/demo.tape">assets/demo.tape</a></sub>

## 명령어

| 명령 | 하는 일 |
|---|---|
| `skilladopt add <저장소> [스킬]` | 스킬을 읽고 이 프로젝트에 맞춤 |
| `skilladopt review <job>` | 자동으로 확인하지 못한 부분을 결정(`--decide b12=keep\|drop\|accept`) |
| `skilladopt apply <job>` | `.agents/skills`(Codex)와 `.claude/skills`(Claude Code)에 설치 |
| `skilladopt impact` | 프로젝트 변경이 입양한 스킬에 주는 영향(`--upstream`은 원본 변경도 확인) |
| `skilladopt update <이름>` | 원본 최신판에 다시 맞춤. 바뀌지 않은 판단은 재사용 |
| `skilladopt status` | 입양한 스킬과 손으로 고친 흔적 |
| `skilladopt doctor` | 이 컴퓨터에서 AI 작업자가 실제로 격리되는지 확인 |

`<job>`에는 `last`를 쓸 수 있습니다. 에이전트 안에서 쓰려면 [skilladopt 에이전트 스킬](skill/skilladopt/SKILL.md)을 넣으세요.

<details>
<summary><b>어떻게 판단하나</b></summary>

스킬의 문단마다 판단이 하나씩 붙고, 의미 있는 판단에는 프로젝트의 근거(의존성, npm 스크립트, `AGENTS.md` 줄)가 달립니다.

| 판단 | 뜻 | 코드가 확인하는 것 |
|---|---|---|
| `keep` | 원문 그대로 | — |
| `bind` | 일반 명령을 내 명령으로 | 명령이나 경로 하나만 넣을 수 있고, 나머지 문장은 똑같아야 하며, 프로젝트에 실제로 있어야 함 |
| `rewrite` | 취지는 맞고 세부가 다름 | 설치 전 항상 사람에게 보여 줌 |
| `drop` | 이 프로젝트와 무관 | "스택 불일치"는 실제로 없는 것을 근거로, 충돌은 `AGENTS.md`의 정확한 줄을 근거로 |
| `review` | AI가 확신하지 못함 | 사람이 결정 |

금지·승인·검증 같은 의무가 담긴 문단은 사람 없이 빼거나 다시 쓰지 않습니다.
`impact`는 근거가 기록된 판단을 다시 확인하고, 입양 뒤 새로 생긴 지침 줄도 보여 줍니다. 근거 없이 그대로 둔 일반 조언은 다시 확인할 대상이 없습니다.
</details>

<details>
<summary><b>안전</b></summary>

- 스킬 안의 어떤 것도 실행하지 않습니다. GitHub API로 고정된 커밋의 파일만 읽습니다.
- AI가 보기 전에 거부하는 것: 숨은 유니코드, 제어 문자, 심링크, 경로 조작, 스크립트가 필요한 스킬.
- AI 작업자는 스킬 본문과 프로젝트 요약만 받습니다. `claude`는 `--safe-mode`에 도구 없이, `codex`는 네트워크 도구와 홈 폴더 접근이 없는 읽기 전용 샌드박스에서 돌아갑니다. `skilladopt doctor`로 내 컴퓨터에서 확인할 수 있습니다(시험이지 증명은 아닙니다).
- 작업자의 답은 코드로 검증합니다. 빠진 판단, 가짜 근거, 사라진 의무, 끼워 넣은 명령, 새 링크, 비밀값, 숨은 주석을 잡아냅니다.
- 설치는 중간에 실패해도 원래대로 돌아가고, 손으로 고친 폴더는 덮어쓰지 않습니다(`--force` 제외).
- 바꾼 사본에도 원본 라이선스와 고지를 유지합니다. 인식된 허용 라이선스가 아니면 `--private`(git에서 제외)가 필요합니다.
</details>

<details>
<summary><b>만들어지는 파일</b></summary>

```
.agents/skills/<이름>/      Codex용 입양 스킬 (+ NOTICE.md)
.claude/skills/<이름>/      Claude Code용            (--target codex|claude|both)
.skilladopt/lock.json       출처, 고정 커밋, 해시
.skilladopt/decisions/      모든 판단과 근거
.skilladopt/upstream/       입양 당시 원본
.skilladopt/approved/       승인한 그대로의 내용
```
</details>

<details>
<summary><b>한계 (v0.1)</b></summary>

- Markdown 스킬만 지원합니다. 스크립트가 필요한 스킬은 거부합니다. 같은 저장소의 공용 Markdown 문서는 함께 가져옵니다(1단계, 다른 스킬 제외).
- 지침 파일은 앞 400줄만 AI에게 전달됩니다(넘으면 알려 줍니다).
- "시간을 아껴 준다"는 아직 측정하지 않았습니다. 써 보시고 좋았던 점과 막힌 점을 이슈로 남겨 주세요.
- macOS에서 Codex CLI 0.161, Claude Code 2.1로 시험했고, 테스트는 리눅스의 Node 20·24에서 돌립니다.
</details>

## 선행 사례

스킬을 개인 프롬프트로 맞추는 일은 새롭지 않습니다. [makerskills](https://github.com/coreyhaines31/makerskills)의 `/skillify`, skillsmith의 `upstream-review`가 있고, [rulesync](https://github.com/dyoshikawa/rulesync)와 [agents-lint](https://github.com/giacomo/agents-lint)는 인접한 문제를 다룹니다. skilladopt는 판단마다 근거를 남기고, 변경이 어느 판단을 무효로 만들었는지 아는 데 집중합니다.

MIT License
