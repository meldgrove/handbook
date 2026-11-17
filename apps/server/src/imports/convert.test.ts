import { describe, expect, it } from "vitest";
import {
  convertVitepress,
  firstHeading,
  inferProperty,
  pathOfFile,
  stripCommonFolder,
  titleFromName,
} from "./convert";

describe("import conversion", () => {
  it("turns VitePress boxes into callouts and keeps code blocks", () => {
    const body = [
      "::: tip",
      "Use the app.",
      "",
      "Second paragraph.",
      ":::",
      "",
      "```md",
      "::: warning",
      "not a box",
      ":::",
      "```",
      "",
      "::: details Show more",
      "Hidden",
      ":::",
      "",
      "## Steps {#steps}",
      "::: unknown",
      "kept",
      ":::",
    ].join("\n");
    const result = convertVitepress(body);
    expect(result.body).toBe(
      [
        "> [!TIP]",
        "> Use the app.",
        ">",
        "> Second paragraph.",
        "",
        "```md",
        "::: warning",
        "not a box",
        ":::",
        "```",
        "",
        "> [!NOTE]",
        "> **Show more**",
        ">",
        "> Hidden",
        "",
        "## Steps",
        "::: unknown",
        "kept",
        ":::",
      ].join("\n"),
    );
    expect(result).toMatchObject({ callouts: 2, anchors: 1 });
  });

  it("maps file names to page paths", () => {
    expect(pathOfFile("index.md")).toEqual({ path: "home", renamed: true });
    expect(pathOfFile("guides/index.md")).toEqual({ path: "guides", renamed: false });
    expect(pathOfFile("guides/Laptop Setup.md")).toEqual({ path: "guides/laptop-setup", renamed: true });
    expect(pathOfFile("!!!.md")).toEqual({ error: "The file name has no letters or digits" });
  });

  it("strips one shared top folder", () => {
    expect([...stripCommonFolder(["docs/a.md", "docs/b/c.md"]).values()]).toEqual(["a.md", "b/c.md"]);
    expect([...stripCommonFolder(["a.md", "docs/b.md"]).values()]).toEqual(["a.md", "docs/b.md"]);
  });

  it("infers property types from values", () => {
    expect(inferProperty("systems", [["Google"], ["Slack"]])?.type).toBe("list");
    expect(inferProperty("reviewed_on", ["2026-01-02"])?.type).toBe("date");
    expect(inferProperty("approved", [true, false])?.type).toBe("boolean");
    expect(inferProperty("weight", [1, 2.5])?.type).toBe("number");
    expect(inferProperty("owner_team", ["it", 3])?.type).toBe("text");
    expect(inferProperty("Bad-Key", ["x"])).toBeNull();
    expect(inferProperty("nested", [{ a: 1 }])).toBeNull();
  });

  it("finds titles", () => {
    expect(firstHeading("Intro\n\n# Main title #\n")).toBe("Main title");
    expect(titleFromName("getting-started.md")).toBe("Getting started");
  });
});
