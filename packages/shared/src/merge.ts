import { diffLines } from "diff";
import { diff3Merge } from "node-diff3";

/**
 * Text merging for pages. Two people (or a person and a change set) that
 * started from the same revision changed a page: `mergeText` combines both
 * changes line by line, like Git. Overlapping changes become conflict
 * blocks that a person resolves:
 *
 *   <<<<<<< yours
 *   your lines
 *   =======
 *   the current lines
 *   >>>>>>> current
 */

export const CONFLICT_START = "<<<<<<< yours";
export const CONFLICT_SEPARATOR = "=======";
export const CONFLICT_END = ">>>>>>> current";

export type MergeResult = { clean: boolean; text: string; conflicts: number };

function lines(text: string): string[] {
  if (text === "") return [];
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

/**
 * Three-way merge: `base` is the text both started from, `yours` the change
 * being saved, `current` the text saved meanwhile.
 */
export function mergeText(base: string, yours: string, current: string): MergeResult {
  if (yours === current) return { clean: true, text: yours, conflicts: 0 };
  if (yours === base) return { clean: true, text: current, conflicts: 0 };
  if (current === base) return { clean: true, text: yours, conflicts: 0 };
  const chunks = diff3Merge(lines(yours), lines(base), lines(current), { excludeFalseConflicts: true });
  const output: string[] = [];
  let conflicts = 0;
  for (const chunk of chunks) {
    if (chunk.ok) output.push(...chunk.ok);
    else if (chunk.conflict) {
      conflicts += 1;
      output.push(CONFLICT_START, ...chunk.conflict.a, CONFLICT_SEPARATOR, ...chunk.conflict.b, CONFLICT_END);
    }
  }
  const text = output.length > 0 ? `${output.join("\n")}\n` : "";
  return { clean: conflicts === 0, text, conflicts };
}

/** True when the text still contains conflict blocks from a merge. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< yours$/m.test(text) && /^>>>>>>> current$/m.test(text);
}

export type TextEdit = { oldText: string; newText: string; replaceAll?: boolean };

export type EditResult = { ok: true; text: string } | { ok: false; index: number; message: string };

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let position = text.indexOf(search);
  while (position !== -1) {
    count += 1;
    position = text.indexOf(search, position + search.length);
  }
  return count;
}

/**
 * Applies "replace this exact text with that" edits in order, as coding
 * agents edit files. Each `oldText` must occur exactly once (or use
 * `replaceAll`), so an edit never lands in the wrong place.
 */
export function applyEdits(text: string, edits: TextEdit[]): EditResult {
  let result = text;
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText === "") return { ok: false, index, message: `Edit ${index + 1}: oldText is empty` };
    const count = countOccurrences(result, edit.oldText);
    if (count === 0) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: oldText was not found. Read the page again and copy the text exactly, including line breaks.`,
      };
    }
    if (count > 1 && !edit.replaceAll) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: oldText occurs ${count} times. Include more surrounding text so it occurs once, or set replaceAll.`,
      };
    }
    result = edit.replaceAll
      ? result.split(edit.oldText).join(edit.newText)
      : result.replace(edit.oldText, () => edit.newText);
  }
  return { ok: true, text: result };
}

/** Added and removed lines between two texts. */
export function lineStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? 0;
    if (part.added) added += count;
    else if (part.removed) removed += count;
  }
  return { added, removed };
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** A line diff for display. */
export function diffTextLines(before: string, after: string): DiffLine[] {
  const result: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const kind = part.added ? "added" : part.removed ? "removed" : "same";
    for (const line of lines(part.value)) result.push({ kind, text: line });
  }
  return result;
}
