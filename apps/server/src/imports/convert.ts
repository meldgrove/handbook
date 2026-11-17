import { isValidSlug, joinPath, slugify } from "@knowledge/shared/paths";
import { PROPERTY_KEY_PATTERN, type PropertyDefinition } from "@knowledge/shared/page";

/**
 * Pure helpers of the import: how files in a zip become page paths, and how
 * Markdown of other tools (VitePress) becomes this app's Markdown.
 */

const CALLOUTS: Record<string, string> = {
  tip: "TIP",
  info: "NOTE",
  note: "NOTE",
  details: "NOTE",
  warning: "WARNING",
  danger: "CAUTION",
  caution: "CAUTION",
  important: "IMPORTANT",
};

// Patterns run on lines of untrusted files: none may backtrack over a line
// (a lazy `.*?` before `\s*$` takes quadratic time on long runs of spaces).
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CONTAINER_OPEN = /^\s{0,3}:::\s*([a-z]+)([\s\S]*)$/i;
const CONTAINER_CLOSE = /^\s{0,3}:::\s*$/;
const HEADING_START = /^#{1,6}\s/;

export type ConvertResult = { body: string; callouts: number; anchors: number };

/**
 * Converts VitePress custom containers (`::: warning Title` … `:::`) into
 * GitHub callouts (`> [!WARNING]`) and removes custom heading anchors
 * (`## Title {#id}`). Code blocks stay untouched.
 */
export function convertVitepress(body: string): ConvertResult {
  const lines = body.split("\n");
  const output: string[] = [];
  let callouts = 0;
  let anchors = 0;
  let fence: string | null = null;
  let container: { kind: string; lines: string[]; title: string } | null = null;
  let depth = 0;

  const flush = () => {
    if (!container) return;
    const quoted: string[] = [`> [!${container.kind}]`];
    if (container.title) quoted.push(`> **${container.title}**`, ">");
    for (const line of container.lines) quoted.push(line.trim() === "" ? ">" : `> ${line}`);
    while (quoted.length > 1 && quoted.at(-1) === ">") quoted.pop();
    output.push(...quoted);
    callouts += 1;
    container = null;
  };

  for (const line of lines) {
    const target = container ? container.lines : output;
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      target.push(line);
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length)
        fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      target.push(line);
      continue;
    }
    if (container) {
      if (CONTAINER_CLOSE.test(line)) {
        if (depth === 0) {
          flush();
          continue;
        }
        depth -= 1;
      } else if (containerOpen(line)) {
        depth += 1;
      }
      container.lines.push(line);
      continue;
    }
    const open = containerOpen(line);
    const kind = open ? CALLOUTS[open.name.toLowerCase()] : undefined;
    if (open && kind) {
      const title = open.title || (open.name.toLowerCase() === "details" ? "Details" : "");
      container = { kind, lines: [], title };
      depth = 0;
      continue;
    }
    const heading = withoutHeadingAnchor(line);
    if (heading !== null) {
      output.push(heading);
      anchors += 1;
      continue;
    }
    output.push(line);
  }
  if (container) flush();
  return { body: output.join("\n"), callouts, anchors };
}

/** `::: warning Title` → its name and title (trimmed); null for other lines. */
function containerOpen(line: string): { name: string; title: string } | null {
  const match = CONTAINER_OPEN.exec(line);
  return match ? { name: match[1]!, title: match[2]!.trim() } : null;
}

/** `## Title {#id}` → `## Title`; null when the line is no heading with a custom anchor. */
function withoutHeadingAnchor(line: string): string | null {
  if (!HEADING_START.test(line)) return null;
  const text = line.trimEnd();
  if (!text.endsWith("}")) return null;
  // The anchor id runs back from the closing brace to whitespace or another `}`.
  const close = text.length - 1;
  let start = close;
  while (start > 0 && !/[\s}]/.test(text[start - 1]!)) start -= 1;
  const open = text.indexOf("{#", start);
  if (open === -1 || open + 2 >= close) return null;
  return text.slice(0, open).trimEnd();
}

export type ImportPath = { path: string; renamed: boolean } | { error: string };

/**
 * The page path of a file in the zip: `a/b.md` and `a/b/index.md` both
 * become `a/b`; a top-level `index.md` becomes `home`. Segments that are not
 * valid slugs are turned into slugs.
 */
export function pathOfFile(name: string): ImportPath {
  const withoutExtension = name.replace(/\.md$/i, "");
  const segments = withoutExtension.split("/").filter(Boolean);
  if (segments.at(-1)?.toLowerCase() === "index") segments.pop();
  if (segments.length === 0) return { path: "home", renamed: true };
  return pathOfSegments(segments);
}

export function pathOfSegments(segments: string[]): ImportPath {
  let renamed = false;
  let path = "";
  for (const segment of segments) {
    let slug = segment;
    if (!isValidSlug(slug)) {
      slug = slugify(segment, "");
      renamed = true;
      if (!slug) return { error: "The file name has no letters or digits" };
    }
    path = joinPath(path || null, slug);
  }
  return { path, renamed };
}

/** If every entry is inside one top-level folder, the names without it. */
export function stripCommonFolder(names: string[]): Map<string, string> {
  const result = new Map(names.map((name) => [name, name]));
  const tops = new Set(names.map((name) => (name.includes("/") ? name.split("/")[0] : "")));
  if (tops.size !== 1) return result;
  const [top] = [...tops];
  if (!top) return result;
  for (const name of names) result.set(name, name.slice(top.length + 1));
  return result;
}

/** A title from a folder or file name: "getting-started" → "Getting started". */
export function titleFromName(name: string): string {
  const words = name.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Untitled";
}

/** The first `# Heading` of a body, if any, without a closing `#` sequence. */
export function firstHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    if (!/^#[ \t]/.test(line)) continue;
    let text = line.slice(2).trim();
    let end = text.length;
    while (end > 0 && text[end - 1] === "#") end -= 1;
    if (end === 0 || /[ \t]/.test(text[end - 1]!)) text = text.slice(0, end).trim();
    if (text) return text;
  }
  return null;
}

/** Frontmatter keys of other tools: renamed or dropped. */
export const KEY_MAPPING: Record<string, string | null> = {
  page_type: "type",
  slug: null,
  last_updated: null,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A property definition inferred from the values an import found for an
 * unknown key, or null when the key cannot be a property key.
 */
export function inferProperty(key: string, values: unknown[]): PropertyDefinition | null {
  if (!PROPERTY_KEY_PATTERN.test(key)) return null;
  const present = values.filter((value) => value !== null && value !== undefined && value !== "");
  let type: PropertyDefinition["type"] = "text";
  if (present.length > 0 && present.every((value) => Array.isArray(value))) type = "list";
  else if (present.length > 0 && present.every((value) => typeof value === "boolean")) type = "boolean";
  else if (present.length > 0 && present.every((value) => typeof value === "number")) type = "number";
  else if (present.length > 0 && present.every((value) => typeof value === "string" && DATE.test(value)))
    type = "date";
  else if (present.some((value) => typeof value === "object" && !Array.isArray(value))) return null;
  return { key, label: titleFromName(key), type, options: [], required: false, help: "" };
}
