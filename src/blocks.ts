import { shortHash } from "./util.js";

export type BlockKind = "heading" | "paragraph" | "list" | "code" | "table" | "quote" | "html";

export interface Block {
  id: string;
  file: string;
  kind: BlockKind;
  level: number; // heading level, 0 for non-headings
  parent: string | null; // id of the nearest enclosing heading
  path: string[]; // heading texts from the top
  text: string;
  hash: string;
  /** Contains a prohibition, approval, verification or safety duty. Dropping it needs a human. */
  obligation: boolean;
  /** Scanner findings that force human review if the block is kept. */
  risk: string[];
}

export interface Frontmatter {
  raw: string | null;
  fields: Record<string, string>;
  /** Top-level entries with their original lines (key line plus indented continuation). */
  entries: { key: string; raw: string }[];
  /** Top-level lines this reader does not understand. Callers must refuse rather than drop them. */
  unparsed: string[];
  body: string;
}

const KEY_LINE = /^(["']?)([A-Za-z0-9_-]+)\1\s*:(.*)$/;

/** Minimal YAML frontmatter reader: top-level `key: value` pairs (plain or quoted keys) only. */
export function parseFrontmatter(src: string): Frontmatter {
  const text = src.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { raw: null, fields: {}, entries: [], unparsed: [], body: text };
  const fields: Record<string, string> = {};
  const entries: { key: string; raw: string }[] = [];
  const unparsed: string[] = [];
  const lines = m[1]!.split("\n");
  for (const line of lines) {
    const top = KEY_LINE.exec(line);
    if (top) entries.push({ key: top[2]!, raw: line });
    else if (entries.length && (/^\s/.test(line) || !line.trim())) entries[entries.length - 1]!.raw += `\n${line}`;
    else if (line.trim() && !line.trim().startsWith("#")) unparsed.push(line);
  }
  for (const e of entries) e.raw = e.raw.replace(/\s+$/, "");
  for (let i = 0; i < lines.length; i++) {
    const kv = KEY_LINE.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[3]!.trim();
    if (value === "|" || value === ">" || value === ">-" || value === "|-" || value === "") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(" ");
    }
    fields[kv[2]!] = unquote(value);
  }
  return { raw: m[1]!, fields, entries, unparsed, body: text.slice(m[0].length) };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return v;
}

const OBLIGATION =
  /\b(never|must not|do not|don't|forbidden|prohibit(?:ed)?|approval|approve|ask the user|confirm with|verify|verification|before (?:committing|merging|deploying|claiming|pushing|release)|back ?up|destructive|irreversible|security|secret|credential)\b|금지|하지\s?마|승인|확인\s?후|검증|백업|절대/i;

export function isObligation(text: string): boolean {
  return OBLIGATION.test(text);
}

const PROHIBITION = /\b(never|must not|do not|don't|forbidden|prohibit(?:ed)?|avoid|unless|only if)\b|금지|하지\s?마|절대/i;

/** The duty and prohibition phrases in a text, lower-cased; a faithful edit keeps all of them. */
export function dutyTerms(text: string): string[] {
  const out: string[] = [];
  for (const re of [OBLIGATION, PROHIBITION]) {
    for (const m of text.matchAll(new RegExp(re.source, "gi"))) out.push(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  return [...new Set(out)];
}

/**
 * Split a markdown body into blocks. Deterministic: the same input gives the same blocks.
 * `counter` carries the running block number across files.
 */
export function splitBlocks(file: string, body: string, counter: { n: number }): Block[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  const headings: { id: string; level: number; text: string }[] = [];
  let buf: string[] = [];
  let bufKind: BlockKind | null = null;

  const push = (kind: BlockKind, textLines: string[], level = 0) => {
    const text = textLines.join("\n").replace(/\s+$/g, "");
    if (!text.trim()) return;
    counter.n += 1;
    const id = `b${String(counter.n).padStart(2, "0")}`;
    while (level > 0 && headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
    const parent = headings.length ? headings[headings.length - 1]!.id : null;
    const path = headings.map((h) => h.text);
    blocks.push({
      id,
      file,
      kind,
      level,
      parent,
      path,
      text,
      hash: shortHash(`${file}\n${text.split("\n").map((l) => l.trimEnd()).join("\n")}`),
      obligation: isObligation(text),
      risk: [],
    });
    if (kind === "heading") headings.push({ id, level, text: text.replace(/^#+\s*/, "").trim() });
  };
  const flush = () => {
    if (bufKind && buf.length) push(bufKind, buf);
    buf = [];
    bufKind = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const marker = fence[2]!;
      const code = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        code.push(l);
        i++;
        if (new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(l)) break;
      }
      push("code", code);
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      flush();
      const html = [line];
      while (!/-->/.test(lines[i]!) && i + 1 < lines.length) html.push(lines[++i]!);
      i++;
      push("html", html);
      continue;
    }
    const heading = /^(#{1,6})\s+\S/.exec(line);
    if (heading) {
      flush();
      push("heading", [line], heading[1]!.length);
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line ends a block, unless an indented line continues the current list item.
      const next = lines[i + 1];
      if (bufKind === "list" && next !== undefined && /^\s{2,}\S/.test(next)) {
        buf.push("");
        i++;
        continue;
      }
      flush();
      i++;
      continue;
    }
    const listItem = /^\s{0,3}([-*+]|\d+[.)])\s+/.test(line);
    const nested = /^\s{2,}([-*+]|\d+[.)])\s+/.test(line);
    if (listItem && nested && bufKind === "list") {
      buf.push(line); // a sub-item belongs to the item above it
      i++;
      continue;
    }
    if (listItem) {
      flush();
      bufKind = "list";
      buf = [line];
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (bufKind !== "table") flush();
      bufKind = "table";
      buf.push(line);
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      if (bufKind !== "quote") flush();
      bufKind = "quote";
      buf.push(line);
      i++;
      continue;
    }
    if (bufKind === "list" || bufKind === "paragraph") {
      buf.push(line);
    } else {
      flush();
      bufKind = "paragraph";
      buf = [line];
    }
    i++;
  }
  flush();
  return blocks;
}
