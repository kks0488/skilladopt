# skilladopt

> **에이전트 스킬, 그냥 설치하지 말고 입양하세요.**

[English](README.md)

![skilladopt 데모: ponytail을 입양한 뒤 팀원이 테스트 명령을 바꾸고 규칙을 추가하자 impact가 다시 볼 곳을 정확히 짚는 장면](assets/demo.gif)

<sub>Codex 작업자로 실제 실행한 화면입니다. 작업자가 스킬을 읽는 약 40초는 잘라냈습니다. 녹화 대본: <a href="assets/demo.tape">assets/demo.tape</a></sub>

남이 만든 에이전트 스킬(`SKILL.md`)은 **그 사람의 프로젝트**를 기준으로 쓰여 있습니다.
인기 스킬을 그대로 넣으면, AI 코딩 에이전트가 작성자의 기술 스택과 명령어, 습관을 따라가기 시작합니다.

`skilladopt`는 외부 스킬을 **내 코드베이스**에 맞게 바꿉니다. 문단마다 왜 남기고, 바꾸고, 뺐는지
**근거를 기록**합니다. 나중에 내 프로젝트나 원본 스킬이 바뀌면 **그 판단 중 정확히 어느 것이**
근거를 잃었는지 알려줍니다.

```bash
npx skilladopt add DietrichGebert/ponytail/.openclaw/skills/ponytail
```

> v0.1은 실험판입니다. Markdown으로만 된 스킬을 지원하고, 스크립트가 들어 있는 스킬은 지금은 거부합니다.

## 왜 필요한가

- 프론트엔드 스킬이 "Tailwind 유틸리티 클래스를 써라"라고 합니다. 우리 프로젝트는 순수 CSS인데, 에이전트가 Tailwind를 넣기 시작합니다.
- 스킬이 "테스트를 돌려라"라고 합니다. 어떤 명령으로요? 스킬은 우리 스크립트를 모릅니다.
- 스킬이 "필요 없는 파일은 지워라"라고 하는데, 우리 `AGENTS.md`는 "docs/는 절대 지우지 마라"라고 합니다. 어느 쪽을 따라야 할까요?
- 이걸 손으로 다 고쳐도, 다음 달 원본이 좋아지거나 우리 프로젝트가 바뀌면 처음부터 다시 해야 합니다.

첫 단계(손으로 맞추기)는 이미 여러 사람이 각자 하고 있습니다.
skilladopt는 **맞추기 → 근거 기록 → 무엇이 낡았는지 알아차리기**의 전 과정을 다루는 도구입니다.

## 동작 방식

```
skilladopt add <스킬>        가져오기(커밋 고정) → 안전 검사 → 프로젝트 읽기
                             → 격리된 AI 작업자가 문단별 판단을 제안
                             → 코드가 모든 판단을 검증 → 미리보기
skilladopt review <job>      코드가 검증하지 못한 부분은 사람이 결정
skilladopt apply <job>       .agents/skills, .claude/skills에 원자적으로 설치
skilladopt impact            어떤 판단이 근거를 잃었나? (AI 없음, CI용)
skilladopt update <이름>     최신 원본에 다시 맞춤. 바뀌지 않은 판단은 재사용
skilladopt doctor            내 컴퓨터에서 작업자 격리가 실제로 되는지 시험
```

문단마다 판단이 하나씩 붙고, 의미 있는 판단에는 프로젝트의 근거가 달립니다.

| 판단 | 뜻 | 코드가 확인하는 것 |
|---|---|---|
| `keep` | 원문 그대로 | — |
| `bind` | 일반 명령을 우리 것으로 ("테스트 돌려" → `` `npm test` ``) | 짧은 한 구간만, 프로젝트에 실제로 있는 명령·경로로만 바꿀 수 있음. 나머지 문장은 완전히 같아야 하고, 의무 표현이나 부정어는 건드릴 수 없음. 쓰인 명령은 코드가 근거로 기록 |
| `rewrite` | 취지는 맞지만 세부가 다름 | **설치 전에 항상 사람에게 보여줌** |
| `drop` | 우리와 무관 | 스택 불일치는 실제로 **없는** 것(예: `dep:tailwindcss`)을 근거로, 충돌은 `AGENTS.md`의 정확한 줄을 근거로 |
| `review` | 작업자가 확신하지 못함 | 사람이 결정 |

의무(금지, 승인, 검증 단계)가 담긴 문단은 사람 없이 지우거나 다시 쓸 수 없습니다.

## 예시

```
$ skilladopt add DietrichGebert/ponytail/.openclaw/skills/ponytail
source   github:DietrichGebert/ponytail/.openclaw/skills/ponytail @ b088b2d · MIT
worker   codex · read-only sandbox, no network tools, no home dir · 25 block(s) to decide
         KEEP 22  REVIEW 3

  REVIEW  b11 4. An installed dependency? Use it. …
          ↳ evidence: agents:AGENTS.md:5 present
            ── proposed ──
            … Never add any new dependency without asking the user first.
  REVIEW  b21 - Lazy code without its check is unfinished …
          ↳ evidence: agents:AGENTS.md:6, script:test, script:typecheck
            ── proposed ──
            … Before saying a task is done, run `npm test` and `npm run typecheck`.

$ skilladopt review last --decide all=accept
$ skilladopt apply last
✓ adopted ponytail → .agents/skills/ponytail, .claude/skills/ponytail
```

일주일 뒤, 팀원이 `AGENTS.md`의 의존성 규칙을 완화하고 테스트 명령을 바꿨습니다.

```
$ skilladopt impact
ponytail  2 of 25 decisions need a re-check · 23 unaffected
  ↻ b11  rewrite  agents:AGENTS.md:5 now says "- New dependencies are fine if they are under 50kb gzipped."
  ↻ b21  rewrite  script:test changed: `vitest run` → `vitest run --coverage`
```

"스킬 전체를 다시 읽으세요"가 아니라 **"이 두 문단을, 이 이유로 다시 보세요"**입니다.
`impact`는 근거(스크립트, 의존성, `AGENTS.md` 줄)가 기록된 판단만 다시 확인합니다. 일반 조언이라 근거 없이 유지한 문단은 확인 대상이 아닙니다. "영향 없음"은 "판단의 근거가 바뀌지 않았다"는 뜻이지 "여전히 완벽하다"는 뜻이 아닙니다. 지침 파일에 새 줄이 생기면 `impact`가 그 줄을 보여주고, `update`는 모든 문단을 새로 판단합니다.
`impact`는 오프라인으로 돌고, 문제가 있으면 0이 아닌 종료 코드를 돌려줘서 CI 검사로 쓸 수 있습니다.

## 설치

Node 20 이상이 필요합니다. 스킬을 읽는 작업자는 이미 쓰고 있는 코딩 에이전트(`codex` 또는 `claude`)를 사용합니다.

```bash
npx skilladopt add <GitHub URL | owner/repo/경로 | ./로컬/폴더>
```

에이전트용 스킬도 [`skill/skilladopt`](skill/skilladopt/SKILL.md)에 있습니다. 에이전트의 스킬 폴더에 넣으면 "이 스킬 입양해줘: <url>"이라고 말하면 됩니다.

## 안전 모델과 한계

- **가져온 내용은 데이터입니다.** 스킬 속 어떤 것도 실행하지 않습니다. 압축 파일을 풀지 않고, GitHub API로 고정 커밋의 파일을 읽습니다.
- **AI가 보기 전에 거부하는 것:** 숨은 유니코드나 방향 제어 문자, 제어 문자, 심링크, 경로 탈출, 스크립트가 필요한 스킬, 같은 저장소의 공용 Markdown 문서가 아닌 폴더 밖 파일.
- **작업자는 격리됩니다.** 프롬프트로 스킬 본문과 프로젝트 요약(의존성 이름, npm 스크립트, `AGENTS.md` 줄)만 받습니다.
  - `claude`: `--safe-mode`(CLAUDE.md, 스킬, 플러그인, 훅, MCP 없음), 도구 없음.
  - `codex`: 읽기 전용 샌드박스, 도구의 네트워크 차단, 홈 폴더 접근 없음.
  - 두 작업자 모두 자기 모델 API와는 당연히 통신합니다.
- **직접 확인할 수 있습니다:** `skilladopt doctor`는 작업자에게 홈 폴더의 함정 파일 읽기, 받지 말아야 할 환경변수 읽기, 파일 쓰기를 시켜 보고, 하나라도 새어 나오면 실패로 판정합니다.
- **작업자를 믿지 않습니다.** 답은 코드로 검증합니다. 모르는 블록, 빠진 판단, 가짜 근거, 사라진 의무, 끼워 넣은 명령, 새 URL, 비밀값, 숨은 주석을 잡아냅니다.
- **정적 검사는 경보 장치일 뿐 증명이 아닙니다.** 검사가 깨끗하다는 건 "눈에 띄는 문제가 없었다"는 뜻입니다.
- **설치는 원자적으로 일어납니다.** 손으로 고쳤거나 관리하지 않는 폴더는 `--force` 없이 덮어쓰지 않고, 심링크를 통해서는 쓰지 않습니다.
- **라이선스.** 바꾼 사본에도 원본 라이선스와 고지를 유지합니다. 인식된 허용 라이선스만 정상 설치하고, 나머지는 `--private`(사본과 기록을 git에서 제외)가 필요합니다.

## 만들어지는 파일

```
.agents/skills/<이름>/      Codex용 입양 스킬 (+ NOTICE.md)
.claude/skills/<이름>/      Claude Code용                 (--target codex|claude|both)
.skilladopt/lock.json       출처, 고정 커밋, 해시
.skilladopt/decisions/      모든 판단과 근거
.skilladopt/upstream/       입양 당시 원본 (나중에 복원·비교용으로 보관)
.skilladopt/approved/       승인한 그대로의 내용 (나중에 복원·비교용으로 보관)
```

설치 중 복구 기록(journal, 백업, 잠금)은 저장소가 아니라 `~/.cache/skilladopt`에 둡니다. 그래서 저장소가 가짜 기록을 심을 수 없습니다.

## v0.1의 한계

- Markdown 스킬만 지원합니다. 스크립트가 필요한 스킬은 거부합니다. 스킬이 폴더 밖의 공용 Markdown 문서를 가리키면 함께 가져옵니다(같은 저장소, 1단계, 다른 스킬은 제외). 그 밖의 폴더 밖 파일은 거부합니다.
- Markdown 분할은 줄 단위이며, 완전한 파서가 아닙니다.
- 지침 파일은 빈 줄을 뺀 앞 400줄만 작업자에게 전달됩니다(넘으면 알려줍니다).
- `doctor`는 내 컴퓨터에서의 시험이지 격리의 증명이 아닙니다. 네트워크 차단은 작업자의 보고이며 검증하지 않습니다.
- 근거는 코드가 볼 수 있는 것(의존성, npm·python 매니페스트, 파일, `AGENTS.md`/`CLAUDE.md` 줄)으로 한정됩니다. 근거가 없는 판단은 `impact`가 무효화를 알아낼 수 없습니다.
- macOS에서 Codex CLI 0.161, Claude Code 2.1로 시험했고, 테스트는 리눅스의 Node 20·24에서도 돌립니다.

## 선행 사례

스킬을 손으로, 또는 개인 프롬프트로 맞추는 일은 새로운 게 아닙니다.
[makerskills](https://github.com/coreyhaines31/makerskills)의 `/skillify` ADAPT, skillsmith의 `upstream-review`,
그리고 인접 문제를 다루는 [rulesync](https://github.com/dyoshikawa/rulesync), [agents-lint](https://github.com/giacomo/agents-lint)가 있습니다.
skilladopt는 근거가 연결된 판단과, 변경이 어느 판단을 무효로 만들었는지 아는 것에 집중합니다.

## 라이선스

MIT
