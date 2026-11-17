import { describe, expect, it } from "vitest";
import { sectionsOf } from "./analyze";

/** Milliseconds a call takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("analyzing page bodies", () => {
  it("leaves callout markers out of section texts", () => {
    expect(sectionsOf("## Setup\n\n> [!NOTE]\n> Keep the charger.\n")).toEqual([
      { position: 0, anchor: "setup", headingPath: ["Setup"], content: "Keep the charger." },
    ]);
  });

  it("splits a code block of many blank lines in time", () => {
    // `^\s*` in the callout pattern took seconds here.
    const body = `## Code\n\n\`\`\`\n${"\n".repeat(60_000)}x\n\`\`\`\n`;
    expect(timed(() => expect(sectionsOf(body)).toHaveLength(1))).toBeLessThan(1500);
  });
});
