import { MAX_PAGE_CHARACTERS } from "./page";

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

/** The lines of each text as numbers: equal lines get the same number, so comparing them is cheap. */
function lineIds(...texts: string[][]): Int32Array[] {
  const ids = new Map<string, number>();
  return texts.map((list) =>
    Int32Array.from(list, (line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    }),
  );
}

/** Lines `oldStart..oldEnd` of the old text became lines `newStart..newEnd` of the new one. */
type Hunk = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };

/**
 * The most work (comparisons and steps) one line diff may take, so that no
 * text within the page limit blocks the server for long. Past it, the diff
 * is one hunk from the first to the last changed line: still correct, only
 * coarser (a merge then conflicts instead of combining both changes).
 */
const DIFF_WORK_LIMIT = 2_000_000;

/** The changed parts between two texts (as line ids), in order. */
function diffHunks(before: Int32Array, after: Int32Array): Hunk[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  if (start === oldEnd && start === newEnd) return [];
  const whole = [{ oldStart: start, oldEnd, newStart: start, newEnd }];
  // Only added or only removed lines.
  if (start === oldEnd || start === newEnd) return slideDown(whole, before, after);
  // The common end stays in: the diff matches lines as early as it can (a
  // kept paragraph keeps the blank line after it), cutting the end off
  // first would match them as late as possible.
  const hunks = shortestEdit(before.subarray(start), after.subarray(start), start);
  return hunks ? slideDown(hunks, before, after) : whole;
}

/**
 * Moves removed or added runs as far down as they go without changing the
 * diff ("a, blank" rather than "blank, a" when a paragraph and its blank
 * line went away), so that changes to neighboring paragraphs merge cleanly.
 */
function slideDown(hunks: Hunk[], before: Int32Array, after: Int32Array): Hunk[] {
  hunks.forEach((hunk, index) => {
    const next = hunks[index + 1];
    // A common line must stay between this hunk and the next.
    const oldLimit = next ? next.oldStart - 1 : before.length;
    const newLimit = next ? next.newStart - 1 : after.length;
    const removed = hunk.newStart === hunk.newEnd;
    const added = hunk.oldStart === hunk.oldEnd;
    while (
      (removed && hunk.oldEnd < oldLimit && before[hunk.oldStart] === before[hunk.oldEnd]) ||
      (added && hunk.newEnd < newLimit && after[hunk.newStart] === after[hunk.newEnd])
    ) {
      hunk.oldStart += 1;
      hunk.oldEnd += 1;
      hunk.newStart += 1;
      hunk.newEnd += 1;
    }
  });
  return hunks;
}

/**
 * Myers' algorithm: the fewest lines removed and added that turn `a` into
 * `b`. Null when that takes more than DIFF_WORK_LIMIT. `offset` is added to
 * the line numbers of the hunks.
 */
function shortestEdit(a: Int32Array, b: Int32Array, offset: number): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  // Round d takes at least 2d + 1 steps, so the limit also bounds the rounds.
  const rounds = Math.min(n + m, Math.ceil(Math.sqrt(DIFF_WORK_LIMIT)));
  const zero = rounds + 1;
  // furthest[zero + k]: the furthest line of `a` reached on diagonal k (= line of a - line of b).
  const furthest = new Int32Array(2 * zero + 1);
  // furthest of each round, for the way back.
  const trace: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= rounds; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && furthest[zero + k - 1]! < furthest[zero + k + 1]!);
      let x = down ? furthest[zero + k + 1]! : furthest[zero + k - 1]! + 1;
      let y = x - k;
      const from = x;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      furthest[zero + k] = x;
      if (x >= n && y >= m) {
        trace.push(furthest.slice(zero - d, zero + d + 1));
        return hunksOf(trace, n, m, offset);
      }
      work += x - from + 1;
      if (work > DIFF_WORK_LIMIT) return null;
    }
    trace.push(furthest.slice(zero - d, zero + d + 1));
  }
  return null;
}

/** Follows the rounds of `shortestEdit` back from the end and collects the removed and added lines as hunks. */
function hunksOf(trace: Int32Array[], n: number, m: number, offset: number): Hunk[] {
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    // Round d - 1 holds diagonals -(d - 1)..(d - 1) at indexes 0..2d - 2.
    const previous = trace[d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && previous[k - 1 + d - 1]! < previous[k + 1 + d - 1]!);
    const previousK = down ? k + 1 : k - 1;
    const previousX = previous[previousK + d - 1]!;
    const previousY = previousX - previousK;
    // Going down adds line previousY of b; going right removes line previousX of a.
    const edit = down
      ? { oldStart: previousX, oldEnd: previousX, newStart: previousY, newEnd: previousY + 1 }
      : { oldStart: previousX, oldEnd: previousX + 1, newStart: previousY, newEnd: previousY };
    const last = hunks.at(-1);
    if (last && last.oldStart === edit.oldEnd && last.newStart === edit.newEnd) {
      last.oldStart = edit.oldStart;
      last.newStart = edit.newStart;
    } else {
      hunks.push(edit);
    }
    x = previousX;
    y = previousY;
  }
  hunks.reverse();
  for (const hunk of hunks) {
    hunk.oldStart += offset;
    hunk.oldEnd += offset;
    hunk.newStart += offset;
    hunk.newEnd += offset;
  }
  return hunks;
}

function sameLines(a: Int32Array, aStart: number, aEnd: number, b: Int32Array, bStart: number, bEnd: number) {
  if (aEnd - aStart !== bEnd - bStart) return false;
  for (let index = 0; index < aEnd - aStart; index += 1) {
    if (a[aStart + index] !== b[bStart + index]) return false;
  }
  return true;
}

/**
 * Three-way merge: `base` is the text both started from, `yours` the change
 * being saved, `current` the text saved meanwhile. Like diff3: the changes
 * of both sides against the base are combined; where both changed the same
 * lines (or lines next to each other) differently, a conflict block shows both.
 */
export function mergeText(base: string, yours: string, current: string): MergeResult {
  if (yours === current) return { clean: true, text: yours, conflicts: 0 };
  if (yours === base) return { clean: true, text: current, conflicts: 0 };
  if (current === base) return { clean: true, text: yours, conflicts: 0 };
  const texts = { base: lines(base), yours: lines(yours), current: lines(current) };
  const [baseIds, yoursIds, currentIds] = lineIds(texts.base, texts.yours, texts.current) as [
    Int32Array,
    Int32Array,
    Int32Array,
  ];
  // Sorted by where they start in the base; your hunks first where both start at the same line.
  const hunks = [
    ...diffHunks(baseIds, yoursIds).map((hunk) => ({ ...hunk, yours: true })),
    ...diffHunks(baseIds, currentIds).map((hunk) => ({ ...hunk, yours: false })),
  ].sort((first, second) => first.oldStart - second.oldStart);

  const output: string[] = [];
  const copy = (from: string[], start: number, end: number) => {
    for (let index = start; index < end; index += 1) output.push(from[index]!);
  };
  let conflicts = 0;
  let position = 0;
  let index = 0;
  while (index < hunks.length) {
    // A region: hunks that overlap or touch in the base.
    const first = hunks[index]!;
    const regionStart = first.oldStart;
    let regionEnd = first.oldEnd;
    let next = index + 1;
    while (next < hunks.length && hunks[next]!.oldStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[next]!.oldEnd);
      next += 1;
    }
    copy(texts.base, position, regionStart);
    if (next === index + 1) {
      copy(first.yours ? texts.yours : texts.current, first.newStart, first.newEnd);
    } else {
      // Both sides changed the region: each side's lines for all of it.
      const span = (yours: boolean) => {
        const sides = hunks.slice(index, next).filter((hunk) => hunk.yours === yours);
        const oldStart = Math.min(...sides.map((hunk) => hunk.oldStart));
        const oldEnd = Math.max(...sides.map((hunk) => hunk.oldEnd));
        const newStart = Math.min(...sides.map((hunk) => hunk.newStart));
        const newEnd = Math.max(...sides.map((hunk) => hunk.newEnd));
        return { start: newStart - (oldStart - regionStart), end: newEnd + (regionEnd - oldEnd) };
      };
      const mine = span(true);
      const theirs = span(false);
      if (sameLines(yoursIds, mine.start, mine.end, currentIds, theirs.start, theirs.end)) {
        copy(texts.yours, mine.start, mine.end);
      } else {
        conflicts += 1;
        output.push(CONFLICT_START);
        copy(texts.yours, mine.start, mine.end);
        output.push(CONFLICT_SEPARATOR);
        copy(texts.current, theirs.start, theirs.end);
        output.push(CONFLICT_END);
      }
    }
    position = regionEnd;
    index = next;
  }
  copy(texts.base, position, texts.base.length);
  const text = output.length > 0 ? `${output.join("\n")}\n` : "";
  return { clean: conflicts === 0, text, conflicts };
}

/** True when the text still contains conflict blocks from a merge. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< yours$/m.test(text) && /^>>>>>>> current$/m.test(text);
}

export type TextEdit = { oldText: string; newText: string; replaceAll?: boolean };

export type EditResult = { ok: true; text: string } | { ok: false; index: number; message: string };

/**
 * Where `search` occurs in `text`, left to right, without overlaps; stops
 * after `limit` places. Knuth, Morris and Pratt's algorithm: linear time for
 * every input (indexOf takes quadratic time on some).
 */
function occurrences(text: string, search: string, limit: number): number[] {
  const positions: number[] = [];
  if (search.length > text.length) return positions;
  // fallback[i]: length of the longest proper prefix of search[0..i] that is also its suffix.
  const fallback = new Int32Array(search.length);
  for (let index = 1, matched = 0; index < search.length; index += 1) {
    const code = search.charCodeAt(index);
    while (matched > 0 && code !== search.charCodeAt(matched)) matched = fallback[matched - 1]!;
    if (code === search.charCodeAt(matched)) matched += 1;
    fallback[index] = matched;
  }
  const first = search.charAt(0);
  for (let index = 0, matched = 0; index < text.length; index += 1) {
    if (matched === 0) {
      // Skip to where a match can start (a fast search for one character).
      index = text.indexOf(first, index);
      if (index === -1) break;
    }
    const code = text.charCodeAt(index);
    while (matched > 0 && code !== search.charCodeAt(matched)) matched = fallback[matched - 1]!;
    if (code === search.charCodeAt(matched)) matched += 1;
    if (matched === search.length) {
      positions.push(index - matched + 1);
      if (positions.length >= limit) break;
      matched = 0;
    }
  }
  return positions;
}

/** Edits of one call replace at most this many places in all (each place costs time). */
export const MAX_REPLACEMENTS = 100_000;

/**
 * Applies "replace this exact text with that" edits in order, as coding
 * agents edit files. Each `oldText` must occur exactly once (or use
 * `replaceAll`), so an edit never lands in the wrong place. No edit may make
 * the text longer than a page may be.
 */
export function applyEdits(text: string, edits: TextEdit[]): EditResult {
  let result = text;
  let replaced = 0;
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText === "") return { ok: false, index, message: `Edit ${index + 1}: oldText is empty` };
    const limit = edit.replaceAll ? MAX_REPLACEMENTS - replaced + 1 : Infinity;
    const positions = occurrences(result, edit.oldText, limit);
    if (positions.length === 0) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: oldText was not found. Read the page again and copy the text exactly, including line breaks.`,
      };
    }
    if (positions.length > 1 && !edit.replaceAll) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: oldText occurs ${positions.length} times. Include more surrounding text so it occurs once, or set replaceAll.`,
      };
    }
    replaced += positions.length;
    if (replaced > MAX_REPLACEMENTS) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: the edits replace more than ${MAX_REPLACEMENTS} places; replace fewer at a time`,
      };
    }
    if (
      result.length + positions.length * (edit.newText.length - edit.oldText.length) >
      MAX_PAGE_CHARACTERS
    ) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: a page may have at most ${MAX_PAGE_CHARACTERS} characters`,
      };
    }
    const parts: string[] = [];
    let last = 0;
    for (const position of positions) {
      parts.push(result.slice(last, position), edit.newText);
      last = position + edit.oldText.length;
    }
    parts.push(result.slice(last));
    result = parts.join("");
  }
  return { ok: true, text: result };
}

/** Added and removed lines between two texts. */
export function lineStats(before: string, after: string): { added: number; removed: number } {
  const [old, next] = lineIds(lines(before), lines(after)) as [Int32Array, Int32Array];
  let added = 0;
  let removed = 0;
  for (const hunk of diffHunks(old, next)) {
    removed += hunk.oldEnd - hunk.oldStart;
    added += hunk.newEnd - hunk.newStart;
  }
  return { added, removed };
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** A line diff for display. */
export function diffTextLines(before: string, after: string): DiffLine[] {
  const old = lines(before);
  const next = lines(after);
  const [oldIds, nextIds] = lineIds(old, next) as [Int32Array, Int32Array];
  const result: DiffLine[] = [];
  let position = 0;
  for (const hunk of diffHunks(oldIds, nextIds)) {
    for (; position < hunk.oldStart; position += 1) result.push({ kind: "same", text: old[position]! });
    for (let index = hunk.oldStart; index < hunk.oldEnd; index += 1) {
      result.push({ kind: "removed", text: old[index]! });
    }
    for (let index = hunk.newStart; index < hunk.newEnd; index += 1) {
      result.push({ kind: "added", text: next[index]! });
    }
    position = hunk.oldEnd;
  }
  for (; position < old.length; position += 1) result.push({ kind: "same", text: old[position]! });
  return result;
}
