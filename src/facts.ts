import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./blocks.js";
import { shortHash, stableStringify, sha256 } from "./util.js";

export type FactState = "present" | "absent" | "unknown";

export interface FactValue {
  state: FactState;
  value?: string;
  hash?: string;
  source?: string;
}

export interface AgentsLine {
  ref: string; // agents:<file>:<line>
  file: string;
  line: number;
  text: string;
  hash: string;
}

export interface ProjectSkill {
  name: string;
  dir: string;
  description: string;
}

export interface Project {
  root: string;
  deps: Map<string, { version: string; scope: string }>;
  pyDeps: Set<string>;
  scripts: Map<string, { command: string; scope: string }>; // key: "name" for root, "<dir>:name" for nested
  ecosystems: Set<string>;
  packageManagers: Set<string>;
  languages: Map<string, number>;
  walkComplete: boolean;
  agents: AgentsLine[];
  skills: ProjectSkill[];
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "vendor", "target",
  ".venv", "venv", "__pycache__", ".skilladopt", "coverage", ".turbo", ".cache", ".idea", ".vscode",
]);

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", rb: "ruby",
  php: "php", cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c", dart: "dart",
  vue: "vue", svelte: "svelte", css: "css", scss: "scss", html: "html", sql: "sql", lua: "lua",
};

const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const MAX_WALK = 20000;

export function readProject(root: string): Project {
  const p: Project = {
    root,
    deps: new Map(),
    pyDeps: new Set(),
    scripts: new Map(),
    ecosystems: new Set(),
    packageManagers: new Set(),
    languages: new Map(),
    walkComplete: true,
    agents: [],
    skills: [],
  };
  const packageJsons: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (seen > MAX_WALK) { p.walkComplete = false; return; }
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".github")) continue;
        if (depth >= 6) { p.walkComplete = false; continue; }
        walk(full, depth + 1);
        continue;
      }
      seen++;
      if (name === "package.json") packageJsons.push(full);
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
      const lang = LANG_BY_EXT[ext];
      if (lang) p.languages.set(lang, (p.languages.get(lang) ?? 0) + 1);
      if (name === "pyproject.toml" || /^requirements.*\.txt$/.test(name) || name === "Pipfile") {
        p.ecosystems.add("python");
        readPythonDeps(full, p.pyDeps);
      }
      if (name === "go.mod") p.ecosystems.add("go");
      if (name === "Cargo.toml") p.ecosystems.add("rust");
      if (name === "Gemfile") p.ecosystems.add("ruby");
      if (name === "composer.json") p.ecosystems.add("php");
      if (name === "pubspec.yaml") p.ecosystems.add("dart");
    }
  };
  walk(root, 0);

  for (const file of packageJsons) {
    p.ecosystems.add("npm");
    const scope = relative(root, join(file, "..")) || ".";
    let pkg: Record<string, unknown>;
    try { pkg = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (deps && typeof deps === "object") {
        for (const [name, version] of Object.entries(deps as Record<string, string>)) {
          const prev = p.deps.get(name);
          p.deps.set(name, { version: String(version), scope: prev ? `${prev.scope},${scope}` : scope });
        }
      }
    }
    const scripts = pkg.scripts;
    if (scripts && typeof scripts === "object") {
      for (const [name, command] of Object.entries(scripts as Record<string, string>)) {
        p.scripts.set(scope === "." ? name : `${scope}:${name}`, { command: String(command), scope });
      }
    }
  }
  for (const [lock, pm] of [["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"], ["uv.lock", "uv"], ["poetry.lock", "poetry"]] as const) {
    if (existsSync(join(root, lock))) p.packageManagers.add(pm);
  }

  for (const file of AGENT_FILES) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    const lines = readFileSync(full, "utf8").replace(/\r\n/g, "\n").split("\n");
    lines.forEach((text, i) => {
      if (!text.trim()) return;
      p.agents.push({ ref: `agents:${file}:${i + 1}`, file, line: i + 1, text, hash: shortHash(text.trim()) });
    });
  }

  for (const base of [".agents/skills", ".claude/skills"]) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const skillMd = join(dir, name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
      p.skills.push({ name: fm.fields.name || name, dir: `${base}/${name}`, description: fm.fields.description || "" });
    }
  }
  return p;
}

function readPythonDeps(file: string, into: Set<string>): void {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return; }
  for (const m of text.matchAll(/^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!;]|["',]|$)/gm)) {
    const name = m[1]!.toLowerCase();
    if (!["python", "name", "version", "description", "requires", "dependencies", "build-system", "project", "tool"].includes(name)) into.add(name);
  }
}

/**
 * Resolve an evidence reference against the project.
 *   dep:<npm-name>  py:<name>  script:<name>  file:<path>  lang:<x>  eco:<x>  pm:<x>  agents:<file>:<line>
 * Anything else resolves to "unknown". Absence is only claimed when we can actually see it.
 */
export function lookup(p: Project, ref: string): FactValue {
  const i = ref.indexOf(":");
  if (i < 1) return { state: "unknown" };
  const ns = ref.slice(0, i);
  const key = ref.slice(i + 1);
  switch (ns) {
    case "dep": {
      const d = p.deps.get(key);
      if (d) return { state: "present", value: d.version, hash: shortHash(d.version), source: `package.json (${d.scope})` };
      // Absence is only claimed when every package.json could be seen.
      return p.ecosystems.has("npm") && p.walkComplete ? { state: "absent", source: "package.json" } : { state: "unknown" };
    }
    case "py": {
      if (p.pyDeps.has(key.toLowerCase())) return { state: "present", source: "python manifests" };
      return p.ecosystems.has("python") && p.walkComplete ? { state: "absent", source: "python manifests" } : { state: "unknown" };
    }
    case "script": {
      const s = p.scripts.get(key);
      if (s) return { state: "present", value: s.command, hash: shortHash(s.command), source: `package.json (${s.scope})` };
      return p.ecosystems.has("npm") && p.walkComplete ? { state: "absent", source: "package.json scripts" } : { state: "unknown" };
    }
    case "file": {
      if (key.includes("..") || key.startsWith("/")) return { state: "unknown" };
      return existsSync(join(p.root, key)) ? { state: "present", source: key } : { state: "absent", source: key };
    }
    case "lang": {
      const n = p.languages.get(key);
      if (n) return { state: "present", value: `${n} files` };
      return p.walkComplete ? { state: "absent" } : { state: "unknown" };
    }
    case "eco":
      return p.ecosystems.has(key) ? { state: "present" } : p.walkComplete ? { state: "absent" } : { state: "unknown" };
    case "pm":
      return p.packageManagers.has(key) ? { state: "present" } : { state: "absent" };
    case "agents": {
      const line = p.agents.find((a) => a.ref === ref);
      return line ? { state: "present", value: line.text.trim(), hash: line.hash, source: line.file } : { state: "absent" };
    }
    default:
      return { state: "unknown" };
  }
}

/** Fingerprint of everything a decision could depend on. Excludes timestamps. */
export function projectHash(p: Project): string {
  return sha256(
    stableStringify({
      deps: [...p.deps.entries()].map(([k, v]) => [k, v.version]).sort(),
      py: [...p.pyDeps].sort(),
      scripts: [...p.scripts.entries()].map(([k, v]) => [k, v.command]).sort(),
      eco: [...p.ecosystems].sort(),
      pm: [...p.packageManagers].sort(),
      langs: [...p.languages.keys()].sort(),
      agents: p.agents.map((a) => a.hash),
    }),
  ).slice(0, 16);
}

/** Compact, human/LLM readable summary used in the worker brief. */
export function describeProject(p: Project): string {
  const lines: string[] = [];
  lines.push(`ecosystems: ${[...p.ecosystems].sort().join(", ") || "(none detected)"}`);
  lines.push(`package managers: ${[...p.packageManagers].sort().join(", ") || "(none)"}`);
  lines.push(`languages: ${[...p.languages.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}(${n})`).join(", ") || "(none)"}`);
  if (p.deps.size) lines.push(`npm dependencies (dep:<name>): ${[...p.deps.keys()].sort().join(", ")}`);
  if (p.pyDeps.size) lines.push(`python dependencies (py:<name>): ${[...p.pyDeps].sort().join(", ")}`);
  if (p.scripts.size) {
    lines.push("npm scripts (script:<name>):");
    for (const [name, s] of [...p.scripts.entries()].sort()) lines.push(`  ${name}: ${s.command}`);
  }
  const notable = ["tsconfig.json", "vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs", "tailwind.config.js", "tailwind.config.ts", "postcss.config.js", "playwright.config.ts", "vitest.config.ts", "jest.config.js", "eslint.config.js", ".eslintrc.json", "biome.json", ".prettierrc", "Dockerfile", "Makefile", "pyproject.toml", "go.mod", "Cargo.toml"];
  const present = notable.filter((f) => existsSync(join(p.root, f)) && statSync(join(p.root, f)).isFile());
  lines.push(`notable files (file:<path>): ${present.join(", ") || "(none)"}`);
  if (p.skills.length) {
    lines.push("skills already installed in this project:");
    for (const s of p.skills) lines.push(`  ${s.name}: ${s.description.slice(0, 160)}`);
  }
  return lines.join("\n");
}
