import { describe, expect, it } from "vitest";
import {
  canonicalPageFile,
  parsePageFile,
  validateFrontmatter,
  withFrontmatter,
  type SpaceSchema,
} from "./page";

const schema: SpaceSchema = {
  properties: [
    { key: "team", label: "Team", type: "select", options: ["it", "hr"], required: false, help: "" },
    { key: "systems", label: "Systems", type: "list", options: [], required: false, help: "" },
    { key: "reviewed_on", label: "Reviewed", type: "date", options: [], required: false, help: "" },
  ],
  pageTypes: [{ key: "workflow", label: "Workflow", template: "", requiredProperties: ["team"] }],
};

describe("page files", () => {
  it("writes one canonical form", () => {
    const result = canonicalPageFile(
      "\uFEFF---\r\nsystems: Google\r\nstatus: active\r\ntitle: Email\r\ntags: [Mail , mail]\r\n---\r\n\r\nBody  \r\n\r\n\r\n",
      schema,
    );
    expect(result.ok && result.markdown).toBe(
      "---\ntitle: Email\ntags:\n  - mail\nsystems:\n  - Google\n---\n\nBody\n",
    );
  });

  it("names unknown and invalid properties", () => {
    const result = validateFrontmatter(
      { title: "", color: "red", team: "sales", reviewed_on: "2026-02-30" },
      schema,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toMatchObject({
      "properties.title": "Add a title",
      "properties.color": expect.stringContaining("Unknown property"),
      "properties.team": "Use one of: it, hr",
      "properties.reviewed_on": "Use a date like 2026-11-17",
    });
  });

  it("checks required properties of page types", () => {
    const result = validateFrontmatter({ title: "A", type: "workflow" }, schema);
    expect(!result.ok && result.errors["properties.team"]).toContain("Workflow");
  });

  it("refuses files without frontmatter and YAML that is not a mapping", () => {
    expect(parsePageFile("# Title", schema).ok).toBe(false);
    expect(parsePageFile("---\n- a\n---\n", schema).ok).toBe(false);
    expect(parsePageFile("---\ntitle: [unclosed\n---\n", schema).ok).toBe(false);
  });

  it("replaces frontmatter and keeps the body", () => {
    expect(withFrontmatter("---\ntitle: A\n---\n\nText\n", { title: "B", tags: [] })).toBe(
      "---\ntitle: B\n---\n\nText\n",
    );
  });
});
