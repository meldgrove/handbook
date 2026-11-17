import { describe, expect, it } from "vitest";
import { markdownProblem } from "@knowledge/shared/markdown";
import { pageLinksOf, parseMarkdown, sectionsOf } from "./analyze";

/** Milliseconds a call takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const from = { space: "it", path: "onboarding/laptop" };

describe("analyzing page bodies", () => {
  it("leaves callout markers out of section texts", () => {
    expect(sectionsOf("## Setup\n\n> [!NOTE]\n> Keep the charger.\n")).toEqual([
      { position: 0, anchor: "setup", headingPath: ["Setup"], content: "Keep the charger." },
    ]);
  });

  it("splits a code block of many blank lines in time", () => {
    // `^\s*` in the callout pattern took seconds here.
    const body = `## Code\n\n\`\`\`\n${"\n".repeat(60_000)}x\n\`\`\`\n`;
    expect(markdownProblem(body)).toBeNull();
    expect(timed(() => expect(sectionsOf(body)).toHaveLength(1))).toBeLessThan(1500);
  });

  it("keeps Markdown the parser cannot handle as plain text", () => {
    // Saving refuses these; a change set item with conflict blocks is not checked.
    const deep = `${">".repeat(20_000)} [a](../vpn)`;
    expect(timed(() => expect(pageLinksOf(deep, from)).toEqual([]))).toBeLessThan(1500);
    const emphasis = "*a**".repeat(40_000);
    expect(timed(() => expect(sectionsOf(emphasis)[0]?.content).toHaveLength(160_000))).toBeLessThan(1500);
  });
});

describe("the limits of markdownProblem", () => {
  // The largest text of each kind the check allows: the parser must still be
  // quick. Tests run micromark's development build (with assertions), three
  // to four times slower than in production, where each takes under 0.7 s.
  const kinds: [string, string][] = [
    ["emphasis", "*a**"],
    ["label ends", "a]"],
    ["HTML comment openers", "a <!--"],
    ["underlined headings", "a\n=\n\n"],
    ["lazy lines", "- a\nb\n"],
    ["quote ends", "> a\n\n"],
    ["nested list items", "- - - - - - - - a\n"],
    ["short lines", "a b\n"],
  ];
  it.each(kinds)("allows only %s that parse in time", (_name, unit) => {
    let low = 0;
    let high = 500_000;
    while (high - low > 500) {
      const middle = Math.floor((low + high) / 2);
      if (markdownProblem(unit.repeat(middle / unit.length))) high = middle;
      else low = middle;
    }
    const text = unit.repeat(low / unit.length);
    expect(markdownProblem(text)).toBeNull();
    expect(timed(() => parseMarkdown(text))).toBeLessThan(4000);
  });
});
