<div align="center">

# skilladopt

**AI 스킬, 그대로 설치하지 말고 입양하세요.**

[![npm](https://img.shields.io/npm/v/skilladopt?color=7ee2a8)](https://www.npmjs.com/package/skilladopt)
[![ci](https://github.com/kks0488/skilladopt/actions/workflows/ci.yml/badge.svg)](https://github.com/kks0488/skilladopt/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-b9a2f0)](LICENSE)

[English](README.md) · [한국어](README.ko.md)

![skilladopt가 하는 일 (20초)](assets/explainer.gif)

</div>

GitHub에서 가져온 Claude Code·Codex용 스킬은 모두 다른 사람의 프로젝트를 기준으로 쓰여 있습니다.
그 사람의 도구를 쓰고, 그 사람의 명령을 돌리고, 그 사람의 규칙을 따르라고 하죠.

skilladopt는 스킬을 넣기 전에 내 프로젝트에 맞게 고치고, 줄마다 왜 바꿨는지 적어 두었다가,
프로젝트가 바뀌면 다시 볼 줄만 알려 줍니다.

## 시작하기

```bash
npx skilladopt anthropics/skills frontend-design
```

GitHub 저장소와 그 안의 스킬 이름입니다(GitHub 링크를 붙여넣어도 됩니다).
스킬을 읽고, 무엇을 유지·변경·제거했는지 보여 주고, 확신이 없는 부분은 묻고, 괜찮다고 하면 설치합니다.

> [!NOTE]
> Node 20 이상과 [Claude Code](https://claude.com/claude-code) 또는 [Codex](https://github.com/openai/codex)가 필요합니다. 스킬을 읽는 일은 둘 중 하나가 합니다.

## 스킬에서 바뀌는 것

| 원래 스킬 | skilladopt 후 | 이유 |
|---|---|---|
| "Tailwind로 스타일링하라." | *(제거)* | `package.json`에 Tailwind가 없음 |
| "테스트를 돌려라." | "`npm test`를 돌려라." | 내 프로젝트의 테스트 명령 |
| "안 쓰는 파일은 지워라." | "안 쓰는 파일은 지우되, `docs/`는 지우지 마라." | 내 `AGENTS.md`의 규칙 (이건 내가 승인) |

모든 줄은 근거와 함께 저장됩니다. 프로젝트와 전혀 맞지 않는 스킬은 거절하고 아무것도 설치하지 않습니다.

## 일주일 뒤

팀원이 테스트 명령 이름을 바꾸고 규칙을 하나 추가했습니다. 이렇게 실행하세요.

```bash
npx skilladopt impact
```

25개 판단 중 근거가 사라진 1개와, 부딪힐 수 있는 새 규칙을 짚어 줍니다. 그 줄만 다시 보고 나머지는 그대로 두면 됩니다.

## 실제 동작

![터미널에서 스킬을 입양하고, 팀원이 테스트 명령을 바꾸고 규칙을 추가하자 impact가 다시 볼 곳을 짚는 장면](assets/demo.gif)

<sub>Codex 작업자로 실제 실행한 화면입니다. 스킬을 읽는 약 40초는 잘라냈습니다. 녹화 대본: <a href="assets/demo.tape">assets/demo.tape</a></sub>

## 명령어

| 명령 | 하는 일 |
|---|---|
| `skilladopt <저장소> [스킬]` | 스킬을 이 프로젝트에 맞추고 설치 |
| `skilladopt impact` | 프로젝트 변경이 영향을 준 판단 보기(`--upstream`은 원본 스킬 변경도 확인) |
| `skilladopt update <이름>` | 원본 최신판에 다시 맞춤. 여전히 맞는 판단은 재사용 |
| `skilladopt status` | 입양한 스킬과 손으로 고친 흔적 |
| `skilladopt doctor` | 이 컴퓨터에서 AI 작업자가 격리되는지 확인 |

대화형 터미널이 아닌 곳(스크립트, CI, 에이전트)에서는 설치 전에 멈춥니다. `skilladopt review last`와 `skilladopt apply last`로 마무리하세요.
에이전트가 이 과정을 대신하게 하려면 [skilladopt 에이전트 스킬](skill/skilladopt/SKILL.md)을 넣으세요.

<details>
<summary><b>어떻게 판단하나</b></summary>

스킬의 문단마다 판단이 하나씩 붙습니다. 의미 있는 판단에는 프로젝트의 근거(의존성, npm 스크립트, `AGENTS.md`의 줄)가 달립니다.

| 판단 | 뜻 | 코드가 확인하는 것 |
|---|---|---|
| `keep` | 원문 그대로 | 확인할 것 없음 |
| `bind` | 일반 명령을 내 명령으로 | 명령이나 경로 하나만 넣을 수 있고, 나머지 문장은 똑같아야 하며, 프로젝트에 실제로 있어야 함 |
| `rewrite` | 취지는 맞고 세부가 다름 | 설치 전 항상 사람에게 보여 줌 |
| `drop` | 이 프로젝트와 무관 | "스택 불일치"는 실제로 없는 것을 근거로, 충돌은 `AGENTS.md`의 정확한 줄을 근거로 |
| `review` | AI가 확신하지 못함 | 사람이 결정 |

금지·승인·검증 같은 의무가 담긴 문단은 사람 없이 빼거나 다시 쓰지 않습니다.
`impact`는 근거가 기록된 판단을 모두 다시 확인하고, 입양 뒤 새로 생긴 지침 줄도 보여 줍니다. 원문 그대로 둔 일반 조언은 다시 확인할 대상이 없습니다.
</details>

<details>
<summary><b>안전</b></summary>

- 스킬 안의 어떤 것도 실행하지 않습니다. GitHub API로 고정된 커밋의 파일만 읽습니다.
- 숨은 유니코드, 제어 문자, 심링크, 경로 조작, 스크립트가 필요한 스킬은 AI가 보기 전에 거부합니다.
- AI 작업자는 스킬 본문과 프로젝트 요약만 받습니다. `claude`는 `--safe-mode`에 도구 없이, `codex`는 네트워크 도구와 홈 폴더 접근이 없는 읽기 전용 샌드박스에서 돌아갑니다. `skilladopt doctor`로 내 컴퓨터에서 확인할 수 있습니다(시험이지 증명은 아닙니다).
- 작업자의 답은 코드로 검증합니다. 빠진 판단, 가짜 근거, 사라진 의무, 끼워 넣은 명령, 새 링크, 비밀값, 숨은 주석을 잡아냅니다.
- 설치는 중간에 실패하면 원래대로 돌아갑니다. 손으로 고친 폴더는 `--force` 없이는 건드리지 않습니다.
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

- Markdown 스킬만 지원합니다. 스크립트가 필요한 스킬은 거부합니다. 스킬이 링크한 같은 저장소의 Markdown 문서는 함께 가져옵니다(1단계, 다른 스킬 제외).
- AI에게는 지침 파일의 앞 400줄만 전달되고, 넘으면 알려 줍니다.
- 시간을 얼마나 아껴 주는지는 아직 측정하지 않았습니다. 써 보시고 좋았던 점과 막힌 점을 이슈로 남겨 주세요.
- macOS에서 Codex CLI 0.161, Claude Code 2.1로 시험했고, 테스트는 리눅스의 Node 20·24에서 돌립니다.
</details>

## 선행 사례

스킬을 프롬프트로 맞추는 일은 전에도 있었습니다. [makerskills](https://github.com/coreyhaines31/makerskills)의 `/skillify`, skillsmith의 `upstream-review`가 있고, [rulesync](https://github.com/dyoshikawa/rulesync)와 [agents-lint](https://github.com/giacomo/agents-lint)는 인접한 문제를 다룹니다. skilladopt는 판단마다 근거를 남기고, 변경이 어느 판단을 무효로 만들었는지 알려 줍니다.
