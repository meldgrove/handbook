import { describe, expect, it } from "vitest";
import { applyEdits, hasConflictMarkers, lineStats, mergeText } from "./merge";

describe("merging", () => {
  const base = "a\nb\nc\nd\n";
  it("combines changes in different places", () => {
    expect(mergeText(base, "A\nb\nc\nd\n", "a\nb\nc\nD\n")).toEqual({
      clean: true,
      text: "A\nb\nc\nD\n",
      conflicts: 0,
    });
  });
  it("marks overlapping changes", () => {
    const result = mergeText(base, "a\nX\nc\nd\n", "a\nY\nc\nd\n");
    expect(result.clean).toBe(false);
    expect(result.text).toBe("a\n<<<<<<< yours\nX\n=======\nY\n>>>>>>> current\nc\nd\n");
    expect(hasConflictMarkers(result.text)).toBe(true);
  });
  it("applies exact edits once", () => {
    expect(applyEdits("one two one", [{ oldText: "two", newText: "2" }])).toEqual({
      ok: true,
      text: "one 2 one",
    });
    expect(applyEdits("one two one", [{ oldText: "one", newText: "1" }]).ok).toBe(false);
    expect(applyEdits("one two one", [{ oldText: "one", newText: "1", replaceAll: true }])).toEqual({
      ok: true,
      text: "1 two 1",
    });
    expect(applyEdits("abc", [{ oldText: "x", newText: "y" }]).ok).toBe(false);
  });
  it("counts lines", () => {
    expect(lineStats("a\nb\n", "a\nc\nd\n")).toEqual({ added: 2, removed: 1 });
  });
});
