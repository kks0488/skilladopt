# Hidden setup for assets/demo.tape (source it from the repository root).
# Builds a throwaway demo project and an isolated skilladopt home, so the recording never depends on local state.
SKILLADOPT_REPO="$PWD"
skilladopt() { node "$SKILLADOPT_REPO/dist/cli.js" "$@"; }
export SKILLADOPT_HOME="$(mktemp -d)"
export GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null)}"
unset CLAUDECODE
DEMO="$(mktemp -d)/star-tactics"
mkdir -p "$DEMO/src" && cd "$DEMO" || return
cat > package.json <<'EOF'
{
  "name": "star-tactics",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "typescript": "5.9.3", "vite": "6.0.0", "vitest": "3.0.0" }
}
EOF
cat > AGENTS.md <<'EOF'
# star-tactics: rules for coding agents

- The game renders on a <canvas>; menus are SVG overlays. No UI frameworks.
- Styling is plain CSS. Do not add CSS frameworks.
- Never add a new dependency without asking the user first.
- Before saying a task is done, run `npm test` and `npm run typecheck`.
EOF
echo 'export {}' > src/main.ts
git init -q && git add -A && git -c user.email=demo@example.com -c user.name=demo commit -qm init
# What a teammate changes a week later: one fact the skill relied on, and one brand-new rule.
teammate() {
  sed -i.bak 's#"test": "vitest run"#"test": "vitest run --coverage"#' package.json && rm -f package.json.bak
  echo '- Never delete files in src/ without asking the user.' >> AGENTS.md
}
export PS1='\[\e[1;32m\]$\[\e[0m\] '
clear
