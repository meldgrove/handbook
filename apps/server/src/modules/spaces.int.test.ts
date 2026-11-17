import { beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, changeSetEvents, changeSetItems, changeSets, spaces, users } from "../db/schema";
import { zipOf } from "../imports/import";
import {
  createPage,
  createSpace,
  createToken,
  createUser,
  request,
  resetDatabase,
  testApp,
} from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

function zipForm(files: Record<string, string>, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([zipOf(files).slice()], "export.zip", { type: "application/zip" }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

describe("spaces API", () => {
  beforeEach(resetDatabase);

  it("creates spaces (admins), lists them with roles and hides archived ones", async () => {
    const admin = await createUser({ isAdmin: true });
    const reader = await createUser();
    expect(
      (await request("POST", "/api/v1/spaces", { userId: reader.id, body: { slug: "it", name: "IT" } }))
        .status,
    ).toBe(403);
    const agent = await createToken(admin.id);
    expect(
      (await request("POST", "/api/v1/spaces", { token: agent, body: { slug: "it", name: "IT" } })).status,
    ).toBe(403);
    const created = await request("POST", "/api/v1/spaces", {
      userId: admin.id,
      body: { slug: "it", name: "IT", description: "Devices and accounts" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: "it",
      pageCount: 0,
      openChangeSets: 0,
      abilities: { manage: true },
    });
    expect(
      (await request("POST", "/api/v1/spaces", { userId: admin.id, body: { slug: "it", name: "Again" } }))
        .status,
    ).toBe(409);
    expect(
      (await request("POST", "/api/v1/spaces", { userId: admin.id, body: { slug: "Not valid", name: "X" } }))
        .status,
    ).toBe(422);

    const list = await request("GET", "/api/v1/spaces", { userId: reader.id });
    expect(list.body.items).toMatchObject([{ slug: "it", myRole: null, archived: false }]);
    await request("POST", "/api/v1/spaces/it/archive", { userId: admin.id });
    expect((await request("GET", "/api/v1/spaces", { userId: reader.id })).body.items).toHaveLength(0);
    const withArchived = await request("GET", "/api/v1/spaces?archived=include", { userId: admin.id });
    expect(withArchived.body.items[0].archived).toBe(true);
    const archived = await request("GET", "/api/v1/spaces/it", { userId: admin.id });
    expect(archived.body.abilities.editLive).toBe(false);
    await request("POST", "/api/v1/spaces/it/unarchive", { userId: admin.id });
    const [row] = await getDb().select().from(spaces).where(eq(spaces.slug, "it"));
    await createPage(row!, { title: "Laptop" });
    await createPage(row!, { title: "VPN" });
    const counted = await request("GET", "/api/v1/spaces", { userId: reader.id });
    expect(counted.body.items[0].pageCount).toBe(2);
    expect((await request("GET", "/api/v1/spaces/it", { userId: reader.id })).body.pageCount).toBe(2);
    const actions = await getDb().select({ action: auditLog.action }).from(auditLog);
    expect(actions.map((row) => row.action)).toEqual(["space.created", "space.archived", "space.unarchived"]);
  });

  it("lets owners choose editors and only admins choose owners", async () => {
    const admin = await createUser({ isAdmin: true });
    const owner = await createUser();
    const editor = await createUser();
    const space = await createSpace({ slug: "it", members: { [owner.id]: "owner", [editor.id]: "editor" } });
    const add = await request("PUT", "/api/v1/spaces/it/members", {
      userId: owner.id,
      body: { email: "New.Person@Example.org", role: "editor" },
    });
    expect(add.status).toBe(200);
    expect(add.body.items).toContainEqual(
      expect.objectContaining({ email: "new.person@example.org", role: "editor", signedIn: false }),
    );
    const [created] = await getDb().select().from(users).where(eq(users.email, "new.person@example.org"));
    expect(created).toBeDefined();
    expect(
      (
        await request("PUT", "/api/v1/spaces/it/members", {
          userId: owner.id,
          body: { email: "x@example.org", role: "owner" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("DELETE", `/api/v1/spaces/it/members/${owner.id}`, { userId: owner.id })).status,
    ).toBe(403);
    expect(
      (
        await request("PUT", "/api/v1/spaces/it/members", {
          userId: editor.id,
          body: { email: "y@example.org", role: "editor" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("PUT", "/api/v1/spaces/it/members", {
          userId: admin.id,
          body: { email: "x@example.org", role: "owner" },
        })
      ).status,
    ).toBe(200);
    const removed = await request("DELETE", `/api/v1/spaces/it/members/${created!.id}`, { userId: owner.id });
    expect(removed.body.items.map((member: { email: string }) => member.email)).not.toContain(
      "new.person@example.org",
    );
    const me = await request("GET", "/api/v1/me", { userId: editor.id });
    expect(me.body.spaces).toEqual([{ slug: space.slug, role: "editor" }]);
  });

  it("changes properties only when every page still fits", async () => {
    const owner = await createUser();
    const space = await createSpace({ slug: "it", members: { [owner.id]: "owner" } });
    const properties = [
      { key: "team", label: "Team", type: "select", options: ["it", "hr"], required: false, help: "" },
    ];
    const set = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: { properties, pageTypes: [{ key: "workflow", label: "Workflow", requiredProperties: ["team"] }] },
    });
    expect(set.status).toBe(200);
    expect(set.body.pageTypes[0]).toMatchObject({ key: "workflow", template: "" });
    await createPage(
      { ...space, properties: set.body.properties, pageTypes: set.body.pageTypes },
      { title: "Backup", markdown: "---\ntitle: Backup\nteam: hr\n---\n" },
    );
    const narrower = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: { properties: [{ ...properties[0], options: ["it"] }] },
    });
    expect(narrower.status).toBe(422);
    expect(narrower.body.error.message).toContain("Backup");
    const broken = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: {
        properties: [],
        pageTypes: [{ key: "workflow", label: "Workflow", requiredProperties: ["team"] }],
      },
    });
    expect(broken.status).toBe(422);
    const renamed = await request("PATCH", "/api/v1/spaces/it", { userId: owner.id, body: { name: "Tech" } });
    expect(renamed.body.name).toBe("Tech");
  });

  it("imports a zip as one change set and exports the space", async () => {
    const editor = await createUser();
    const owner = await createUser();
    const space = await createSpace({ slug: "it", members: { [editor.id]: "editor", [owner.id]: "owner" } });
    await createPage(space, { title: "Existing", body: "Old text.\n" });
    const files = {
      "docs/index.md": "---\ntitle: Start here\n---\n\n# Start here\n",
      "docs/existing.md": "---\ntitle: Existing\n---\n\nNew text.\n",
      "docs/workflows/email-aliases.md":
        "---\ntitle: Email aliases\npage_type: workflow\nslug: email-aliases\nlast_updated: 2026-10-21\nagent_id: x.y\n---\n\n::: warning Careful\nCheck the domain.\n:::\n\n## Steps {#steps}\n",
      "docs/_templates/tool.md": "---\ntitle: Template\n---\n",
      "docs/logo.png": "png",
    };
    const asEditor = await request("POST", "/api/v1/spaces/it/import", {
      userId: editor.id,
      form: zipForm(files),
    });
    expect(asEditor.status).toBe(201);
    expect(asEditor.body).toMatchObject({
      created: 3,
      updated: 1,
      unchanged: 0,
      droppedProperties: ["agent_id", "type"],
    });
    expect(asEditor.body.skipped.map((item: { file: string }) => item.file).sort()).toEqual([
      "_templates/tool.md",
      "logo.png",
    ]);
    expect(asEditor.body.notes.join(" ")).toContain("1 VitePress boxes");
    const [changeSet] = await getDb()
      .select()
      .from(changeSets)
      .where(eq(changeSets.number, asEditor.body.changeSet.number));
    expect(changeSet).toMatchObject({ status: "open", channel: "web", authorId: editor.id });
    const items = await getDb()
      .select()
      .from(changeSetItems)
      .where(eq(changeSetItems.changeSetId, changeSet!.id));
    expect(items.map((item) => [item.path, item.action]).sort()).toEqual([
      ["existing", "update"],
      ["home", "create"],
      ["workflows", "create"],
      ["workflows/email-aliases", "create"],
    ]);
    const aliases = items.find((item) => item.path === "workflows/email-aliases")!;
    expect(aliases.markdown).toBe(
      "---\ntitle: Email aliases\n---\n\n> [!WARNING]\n> **Careful**\n>\n> Check the domain.\n\n## Steps\n",
    );
    const events = await getDb()
      .select()
      .from(changeSetEvents)
      .where(eq(changeSetEvents.changeSetId, changeSet!.id));
    expect(events.map((event) => event.kind).sort()).toEqual([
      "created",
      "edited",
      "edited",
      "edited",
      "edited",
    ]);

    // Owners may add the unknown keys and page types to the space instead.
    const asOwner = await request("POST", "/api/v1/spaces/it/import", {
      userId: owner.id,
      form: zipForm(files, { defineProperties: "true", title: "IT pages" }),
    });
    expect(asOwner.body).toMatchObject({
      definedProperties: ["agent_id"],
      definedPageTypes: ["workflow"],
      droppedProperties: [],
    });
    const [second] = await getDb()
      .select()
      .from(changeSets)
      .where(eq(changeSets.number, asOwner.body.changeSet.number));
    expect(second!.title).toBe("IT pages");

    const reader = await createUser();
    expect(
      (await request("POST", "/api/v1/spaces/it/import", { userId: reader.id, form: zipForm(files) })).status,
    ).toBe(403);
    const notZip = new FormData();
    notZip.append("file", new File(["hello"], "a.zip"));
    expect(
      (await request("POST", "/api/v1/spaces/it/import", { userId: editor.id, form: notZip })).status,
    ).toBe(400);

    const response = await testApp().request("/api/v1/spaces/it/export", {
      headers: { "x-test-user": reader.id },
    });
    expect(response.headers.get("content-type")).toBe("application/zip");
    const exported = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(exported).sort()).toEqual(["_space.yaml", "existing.md"]);
    expect(strFromU8(exported["existing.md"]!)).toBe("---\ntitle: Existing\n---\n\nOld text.\n");
    expect(strFromU8(exported["_space.yaml"]!)).toContain("pageTypes:");
  });
});
