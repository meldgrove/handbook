import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { getDb } from "../db/client";
import { spaces } from "../db/schema";
import { spaceContext } from "../spaces/access";
import { createSpace, createUser, request, resetDatabase, testApp } from "../test/helpers";
import { resolveSession } from "../test/resolve-mock";
import { zipBomb } from "../test/zip-bomb";
import { importSpace, zipOf } from "./import";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

function zipForm(data: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([data.slice()], "export.zip", { type: "application/zip" }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

describe("space import", () => {
  beforeEach(resetDatabase);

  it("refuses files that inflate beyond their declared size, without inflating them", async () => {
    const editor = await createUser();
    await createSpace({ slug: "it", members: { [editor.id]: "editor" } });
    // 80 entries of 64 MB each, declared as 100 bytes: 5 GB to inflate.
    const bomb = zipBomb({ entries: 80, inflatedBytes: 64 * 1024 * 1024, declaredBytes: 100 });
    const start = performance.now();
    const response = await request("POST", "/api/v1/spaces/it/import", {
      userId: editor.id,
      form: zipForm(bomb),
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("This is not a zip file, or it is damaged");
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("skips a _space.yaml over 1 MB without reading it", async () => {
    const owner = await createUser();
    await createSpace({ slug: "it", members: { [owner.id]: "owner" } });
    const yaml = `order:\n${"  - a\n".repeat(700_000)}`;
    const start = performance.now();
    const response = await request("POST", "/api/v1/spaces/it/import", {
      userId: owner.id,
      form: zipForm(zipOf({ "_space.yaml": yaml, "a.md": "# A\n" }), { defineProperties: "true" }),
    });
    expect(response.status).toBe(201);
    expect(response.body.skipped).toEqual([{ file: "_space.yaml", reason: "The file is larger than 1 MB" }]);
    expect(response.body.created).toBe(1);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("keeps properties an owner added while the import ran", async () => {
    const owner = await createUser();
    const space = await createSpace({ slug: "it", members: { [owner.id]: "owner" } });
    const principal = (await resolveSession(getDb(), new Headers({ "x-test-user": owner.id })))!;
    const context = await spaceContext(getDb(), principal, "it");
    const team = { key: "team", label: "Team", type: "text", options: [], required: false, help: "" };
    const changed = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: { properties: [team] },
    });
    expect(changed.status).toBe(200);

    const result = await importSpace(getDb(), principal, context, {
      data: zipOf({ "a.md": "---\ntitle: A\nsystem: Mail\n---\n" }),
      fileName: "a.zip",
      defineProperties: true,
    });
    expect(result.definedProperties).toEqual(["system"]);
    const [row] = await getDb().select().from(spaces).where(eq(spaces.id, space.id));
    expect(row!.properties.map((property) => property.key)).toEqual(["team", "system"]);
  });

  it("exports a large space without blocking other requests", async () => {
    const reader = await createUser();
    const space = await createSpace({ slug: "it" });
    // 300 pages of about 100 KB that compress poorly.
    await getDb().execute(sql`
      insert into pages (space_id, path, revision, title, markdown)
      select ${space.id}, 'page-' || n, 1, 'Page ' || n,
        (select string_agg(md5(n || '-' || g), ' ') from generate_series(1, 3000) g)
      from generate_series(1, 300) n`);
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    const response = await testApp().request("/api/v1/spaces/it/export", {
      headers: { "x-test-user": reader.id },
    });
    // The timer runs once more after the export.
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(timer);
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(response.status).toBe(200);
    expect(Object.keys(zip)).toHaveLength(301);
    expect(strFromU8(zip["page-7.md"]!)).toMatch(/^[0-9a-f]{32} /);
    expect(strFromU8(zip["_space.yaml"]!)).toContain("- page-1\n");
    expect(longest).toBeLessThan(250);
  });
});
