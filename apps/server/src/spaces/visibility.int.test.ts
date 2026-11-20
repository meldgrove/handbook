import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { unzipSync } from "fflate";
import { spaceAbilities, type SpaceRole } from "@handbook/shared/roles";
import { getDb, type DbOrTx } from "../db/client";
import { changeSetItems, changeSets, pages, spaces } from "../db/schema";
import { issueCredential } from "../auth/credentials";
import type { Principal } from "../auth/principal";
import { deleteLivePage, lockPage, type PageRow } from "../pages/core";
import {
  createPage,
  createSpace,
  createToken,
  createUser,
  request,
  resetDatabase,
  testApp,
} from "../test/helpers";
import { spaceContext } from "./access";
import { spaceVisibility, visibilityOf, type Visibility } from "./visibility";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const file = (title: string, body = "", extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}`;

type SpaceRow = typeof spaces.$inferSelect;

function person(
  user: { id: string; email: string; name: string; isAdmin: boolean },
  agent = false,
): Principal {
  return {
    kind: "user",
    id: user.id,
    email: user.email,
    name: user.name,
    image: null,
    isAdmin: user.isAdmin,
    channel: agent ? "token" : "web",
    agent,
    clientName: agent ? "Test agent" : null,
    credentialId: null,
  };
}

const service: Principal = {
  kind: "service",
  credentialId: "00000000-0000-0000-0000-000000000000",
  name: "Bot",
};

/** The rule as `spaceAbilities` states it, from the roles this test gave out. */
function seesDraftsBySpaceAbilities(
  principal: Principal,
  role: SpaceRole | null,
  archived: boolean,
): boolean {
  if (principal.kind === "service") {
    return spaceAbilities({ isAdmin: false, role: null, agent: true, readOnly: true }).seeDrafts;
  }
  return spaceAbilities({
    isAdmin: principal.isAdmin,
    role,
    agent: principal.agent,
    readOnly: false,
    archived,
  }).seeDrafts;
}

async function trash(page: PageRow, space: SpaceRow) {
  await getDb().transaction(async (tx) => {
    const locked = await lockPage(tx, page.id);
    await deleteLivePage(tx, { space, page: locked, author: { userId: null, via: "api", clientName: null } });
  });
}

async function ids(db: DbOrTx, condition: ReturnType<Visibility["livePages"]>) {
  const rows = await db.select({ id: pages.id }).from(pages).where(condition);
  return new Set(rows.map((row) => row.id));
}

describe("page visibility", () => {
  beforeEach(resetDatabase);

  /**
   * Spaces: an active one, an archived one (same members) and another active
   * one. Each has an active, a deprecated and a draft page, and a draft and
   * an active page in the trash; each has a change set that changes a draft
   * and one that does not.
   */
  async function world() {
    const admin = await createUser({ isAdmin: true });
    const owner = await createUser();
    const editor = await createUser();
    const otherEditor = await createUser();
    const reader = await createUser();
    const main = await createSpace({ slug: "main", members: { [owner.id]: "owner", [editor.id]: "editor" } });
    const archived = await createSpace({
      slug: "old",
      members: { [owner.id]: "owner", [editor.id]: "editor" },
    });
    const other = await createSpace({ slug: "other", members: { [otherEditor.id]: "editor" } });
    const roles = new Map<string, Map<string, SpaceRole>>([
      [
        owner.id,
        new Map([
          [main.id, "owner" as const],
          [archived.id, "owner" as const],
        ]),
      ],
      [
        editor.id,
        new Map([
          [main.id, "editor" as const],
          [archived.id, "editor" as const],
        ]),
      ],
      [otherEditor.id, new Map([[other.id, "editor" as const]])],
    ]);

    type Fixture = { page: PageRow; space: SpaceRow; status: string; live: boolean };
    const fixtures: Fixture[] = [];
    const changeSetFixtures: { id: string; space: SpaceRow; touchesDraft: boolean }[] = [];
    for (const space of [main, archived, other]) {
      for (const status of ["active", "deprecated", "draft"]) {
        const page = await createPage(space, {
          title: `${status} page`,
          markdown: file(`${status} page`, "Text.\n", `status: ${status}\n`),
        });
        fixtures.push({ page, space, status, live: true });
      }
      for (const status of ["active", "draft"]) {
        const page = await createPage(space, {
          title: `trashed ${status}`,
          markdown: file(`trashed ${status}`, "", `status: ${status}\n`),
        });
        await trash(page, space);
        fixtures.push({ page, space, status, live: false });
      }
      for (const status of ["active", "draft"]) {
        const target = fixtures.find(
          (fixture) => fixture.space.id === space.id && fixture.status === status,
        )!;
        const [changeSet] = await getDb()
          .insert(changeSets)
          .values({ spaceId: space.id, title: `Change ${status}`, authorId: reader.id, channel: "web" })
          .returning();
        await getDb().insert(changeSetItems).values({
          changeSetId: changeSet!.id,
          pageId: target.page.id,
          action: "update",
          path: target.page.path,
          baseRevision: target.page.revision,
          markdown: target.page.markdown,
        });
        changeSetFixtures.push({ id: changeSet!.id, space, touchesDraft: status === "draft" });
      }
    }
    await getDb().update(spaces).set({ archivedAt: new Date() }).where(eq(spaces.id, archived.id));
    const spacesNow = await getDb().select().from(spaces);
    const fresh = (space: SpaceRow) => spacesNow.find((row) => row.id === space.id)!;

    const principals: [string, Principal][] = [
      ["admin", person(admin)],
      ["admin's agent", person(admin, true)],
      ["owner", person(owner)],
      ["editor", person(editor)],
      ["editor's agent", person(editor, true)],
      ["editor of another space", person(otherEditor)],
      ["reader", person(reader)],
      ["reader's agent", person(reader, true)],
      ["service token", service],
    ];
    const roleOf = (principal: Principal, space: SpaceRow) =>
      principal.kind === "user" ? (roles.get(principal.id)?.get(space.id) ?? null) : null;
    const seesDrafts = (principal: Principal, space: SpaceRow) =>
      seesDraftsBySpaceAbilities(principal, roleOf(principal, space), fresh(space).archivedAt !== null);
    return {
      spaces: [main, archived, other].map(fresh),
      fixtures: fixtures.map((fixture) => ({ ...fixture, space: fresh(fixture.space) })),
      changeSetFixtures,
      principals,
      seesDrafts,
    };
  }

  it("matches spaceAbilities for every kind of principal, role and page status", async () => {
    const { spaces: allSpaces, fixtures, changeSetFixtures, principals, seesDrafts } = await world();
    const db = getDb();
    for (const [name, principal] of principals) {
      const visible = (fixture: (typeof fixtures)[number]) =>
        fixture.live && (fixture.status !== "draft" || seesDrafts(principal, fixture.space));
      const expected = new Set(fixtures.filter(visible).map((fixture) => fixture.page.id));
      const everywhere = await visibilityOf(db, principal);

      // Lists across spaces, through the pages table and through an alias.
      expect(await ids(db, everywhere.livePages()), name).toEqual(expected);
      const aliased = await db.execute<{ id: string }>(
        sql`select p.id from pages p where ${everywhere.livePages({
          spaceId: sql`p.space_id`,
          status: sql`p.status`,
          deletedAt: sql`p.deleted_at`,
        })}`,
      );
      expect(new Set(aliased.rows.map((row) => row.id)), name).toEqual(expected);

      for (const space of allSpaces) {
        const sees = seesDrafts(principal, space);
        const inSpace = spaceVisibility(await spaceContext(db, principal, space));
        const expectedHere = new Set(
          fixtures
            .filter((fixture) => fixture.space.id === space.id && visible(fixture))
            .map((f) => f.page.id),
        );
        // Lists within one space.
        expect(await ids(db, and(eq(pages.spaceId, space.id), inSpace.livePages())!), name).toEqual(
          expectedHere,
        );
        for (const visibility of [everywhere, inSpace]) {
          expect(visibility.seesDrafts(space.id), `${name} in ${space.slug}`).toBe(sees);
          expect(visibility.seesTrash(space.id), `${name} in ${space.slug}`).toBe(sees);
        }
        // Single reads (live or in the trash: the status decides).
        for (const fixture of fixtures.filter((candidate) => candidate.space.id === space.id)) {
          const may = fixture.status !== "draft" || sees;
          expect(everywhere.canSeePage(fixture.page), `${name}: ${fixture.page.title}`).toBe(may);
          expect(inSpace.canSeePage(fixture.page), `${name}: ${fixture.page.title}`).toBe(may);
          if (may) expect(() => inSpace.assertPage(fixture.page)).not.toThrow();
          else expect(() => inSpace.assertPage(fixture.page)).toThrow("No such page");
        }
        // One change set at a time.
        for (const changeSet of changeSetFixtures.filter((candidate) => candidate.space.id === space.id)) {
          const may = !changeSet.touchesDraft || sees;
          const row = { id: changeSet.id, spaceId: space.id };
          expect(await inSpace.canSeeChangeSet(db, row), name).toBe(may);
          expect(await everywhere.canSeeChangeSet(db, row), name).toBe(may);
        }
      }

      // Change set lists across spaces.
      const listed = await db.select({ id: changeSets.id }).from(changeSets).where(everywhere.changeSets());
      const expectedChangeSets = changeSetFixtures
        .filter((changeSet) => !changeSet.touchesDraft || seesDrafts(principal, changeSet.space))
        .map((changeSet) => changeSet.id);
      expect(new Set(listed.map((row) => row.id)), name).toEqual(new Set(expectedChangeSets));
    }
  });

  it("asks the database nothing when the principal sees drafts everywhere or nowhere", async () => {
    const admin = await createUser({ isAdmin: true });
    const noDatabase = new Proxy({} as DbOrTx, {
      get() {
        throw new Error("no query expected");
      },
    });
    expect((await visibilityOf(noDatabase, person(admin))).seesDrafts("any space")).toBe(true);
    expect((await visibilityOf(noDatabase, person(admin, true))).seesDrafts("any space")).toBe(true);
    expect((await visibilityOf(noDatabase, service)).seesDrafts("any space")).toBe(false);
  });
});

describe("read paths hide drafts from those who may not see them", () => {
  beforeEach(resetDatabase);

  async function setup() {
    const editor = await createUser({ name: "Eddie Editor" });
    const otherEditor = await createUser({ name: "Otto Other" });
    const reader = await createUser({ name: "Rita Reader" });
    const admin = await createUser({ name: "Ada Admin", isAdmin: true });
    const it = await createSpace({ slug: "it", name: "IT", members: { [editor.id]: "editor" } });
    const hr = await createSpace({ slug: "hr", name: "HR", members: { [otherEditor.id]: "editor" } });
    const laptop = await createPage(it, {
      title: "Laptop",
      markdown: file("Laptop", "Hello.\n", "tags: [hardware]\n"),
    });
    const plan = await createPage(it, {
      title: "Plan",
      markdown: file("Plan", "See [the laptop](laptop).\n", "status: draft\ntags: [hardware, secret]\n"),
    });
    await createPage(it, {
      title: "Below plan",
      parentPath: "plan",
      markdown: file("Below plan", "Visible below a draft.\n"),
    });
    await createPage(hr, {
      title: "Hiring",
      markdown: file("Hiring", "Needs [a laptop](/s/it/laptop).\n", "status: draft\ntags: [secret]\n"),
    });
    await createPage(hr, {
      title: "Holidays",
      markdown: file("Holidays", "Bring [a laptop](/s/it/laptop).\n", "tags: [time-off]\n"),
    });
    const { secret: serviceToken } = await issueCredential(getDb(), {
      kind: "service",
      name: "Bot",
      userId: null,
      expiresAt: null,
    });
    const editorAgent = await createToken(editor.id);
    return { editor, otherEditor, reader, admin, laptop, plan, serviceToken, editorAgent };
  }

  type Viewer = { userId?: string; token?: string };

  it("backlinks show only pages the viewer may see, across spaces", async () => {
    const { editor, otherEditor, reader, admin, laptop, serviceToken, editorAgent } = await setup();
    const backlinks = async (viewer: Viewer) => {
      const view = await request("GET", `/api/v1/pages/${laptop.id}`, viewer);
      return view.body.backlinks.map((link: { title: string }) => link.title).sort();
    };
    expect(await backlinks({ userId: reader.id })).toEqual(["Holidays"]);
    expect(await backlinks({ token: serviceToken })).toEqual(["Holidays"]);
    // Editors of the page's space do not see drafts of another space, and the reverse.
    expect(await backlinks({ userId: editor.id })).toEqual(["Holidays", "Plan"]);
    expect(await backlinks({ token: editorAgent })).toEqual(["Holidays", "Plan"]);
    expect(await backlinks({ userId: otherEditor.id })).toEqual(["Hiring", "Holidays"]);
    expect(await backlinks({ userId: admin.id })).toEqual(["Hiring", "Holidays", "Plan"]);
  });

  it("tags and tag pages count and list only visible pages", async () => {
    const { editor, otherEditor, reader, admin, serviceToken } = await setup();
    const tags = async (viewer: Viewer) => (await request("GET", "/api/v1/tags", viewer)).body.items;
    const tagged = async (tag: string, viewer: Viewer) =>
      (await request("GET", `/api/v1/tags/${tag}/pages`, viewer)).body.items
        .map((page: { title: string }) => page.title)
        .sort();
    const readerTags = [
      { tag: "hardware", count: 1 },
      { tag: "time-off", count: 1 },
    ];
    expect(await tags({ userId: reader.id })).toEqual(readerTags);
    expect(await tags({ token: serviceToken })).toEqual(readerTags);
    expect(await tags({ userId: editor.id })).toEqual([
      { tag: "hardware", count: 2 },
      { tag: "secret", count: 1 },
      { tag: "time-off", count: 1 },
    ]);
    expect(await tags({ userId: admin.id })).toEqual([
      { tag: "hardware", count: 2 },
      { tag: "secret", count: 2 },
      { tag: "time-off", count: 1 },
    ]);
    expect(await tagged("secret", { userId: reader.id })).toEqual([]);
    expect(await tagged("secret", { userId: editor.id })).toEqual(["Plan"]);
    expect(await tagged("secret", { userId: otherEditor.id })).toEqual(["Hiring"]);
    expect(await tagged("secret", { userId: admin.id })).toEqual(["Hiring", "Plan"]);
    expect(await tagged("hardware", { token: serviceToken })).toEqual(["Laptop"]);
  });

  it("exports drafts only to those who see them", async () => {
    const { editor, otherEditor, reader, admin, serviceToken, editorAgent } = await setup();
    const exported = async (viewer: Viewer) => {
      const headers: Record<string, string> = viewer.userId
        ? { "x-test-user": viewer.userId }
        : { authorization: `Bearer ${viewer.token}` };
      const response = await testApp().request("/api/v1/spaces/it/export", { headers });
      expect(response.status).toBe(200);
      return Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))
        .filter((name) => name.endsWith(".md"))
        .sort();
    };
    const withoutDrafts = ["laptop.md", "plan/below-plan.md"];
    const withDrafts = ["laptop.md", "plan.md", "plan/below-plan.md"];
    expect(await exported({ userId: reader.id })).toEqual(withoutDrafts);
    expect(await exported({ token: serviceToken })).toEqual(withoutDrafts);
    expect(await exported({ userId: otherEditor.id })).toEqual(withoutDrafts);
    expect(await exported({ userId: editor.id })).toEqual(withDrafts);
    expect(await exported({ token: editorAgent })).toEqual(withDrafts);
    expect(await exported({ userId: admin.id })).toEqual(withDrafts);
  });

  it("the space index lists drafts only to those who see them, and pages below a draft to everyone", async () => {
    const { editor, otherEditor, reader, admin, serviceToken } = await setup();
    const index = async (viewer: Viewer) => (await request("GET", "/s/it.md", viewer)).body as string;
    for (const viewer of [{ userId: reader.id }, { token: serviceToken }, { userId: otherEditor.id }]) {
      const text = await index(viewer);
      expect(text).not.toContain("[Plan]");
      // The page below the draft stays listed, at the top level.
      expect(text).toContain("- [Below plan](/s/it/plan/below-plan.md)");
    }
    for (const viewer of [{ userId: editor.id }, { userId: admin.id }]) {
      expect(await index(viewer)).toContain(
        "- [Plan](/s/it/plan.md)\n  - [Below plan](/s/it/plan/below-plan.md)",
      );
    }
  });

  it("children, the recent feed and the history of trashed pages follow the same rule", async () => {
    const { editor, otherEditor, reader, admin, laptop, plan } = await setup();
    await createPage((await getDb().select().from(spaces).where(eq(spaces.slug, "it")))[0]!, {
      title: "Draft child",
      parentPath: "laptop",
      markdown: file("Draft child", "", "status: draft\n"),
    });
    const children = async (userId: string) =>
      (await request("GET", `/api/v1/pages/${laptop.id}`, { userId })).body.children.map(
        (child: { title: string }) => child.title,
      );
    expect(await children(reader.id)).toEqual([]);
    expect(await children(otherEditor.id)).toEqual([]);
    expect(await children(editor.id)).toEqual(["Draft child"]);

    const recent = async (userId: string) =>
      (await request("GET", "/api/v1/recent?limit=50", { userId })).body.items
        .map((item: { page: { title: string } }) => item.page.title)
        .sort();
    expect(await recent(reader.id)).toEqual(["Below plan", "Holidays", "Laptop"]);
    expect(await recent(otherEditor.id)).toEqual(["Below plan", "Hiring", "Holidays", "Laptop"]);
    expect(await recent(editor.id)).toEqual(["Below plan", "Draft child", "Holidays", "Laptop", "Plan"]);
    expect(await recent(admin.id)).toEqual([
      "Below plan",
      "Draft child",
      "Hiring",
      "Holidays",
      "Laptop",
      "Plan",
    ]);

    // A page in the trash: its history only for the space's editors.
    const below = await request("GET", "/api/v1/spaces/it/pages/by-path?path=plan/below-plan", {
      userId: editor.id,
    });
    expect((await request("DELETE", `/api/v1/pages/${below.body.id}`, { userId: editor.id })).status).toBe(
      204,
    );
    expect(
      (await request("GET", `/api/v1/pages/${below.body.id}/revisions`, { userId: reader.id })).status,
    ).toBe(404);
    expect(
      (await request("GET", `/api/v1/pages/${below.body.id}/revisions`, { userId: editor.id })).status,
    ).toBe(200);
    // A draft: 404 for readers on every read.
    for (const path of [`/api/v1/pages/${plan.id}`, `/api/v1/pages/${plan.id}/revisions`, "/s/it/plan.md"]) {
      expect((await request("GET", path, { userId: reader.id })).status, path).toBe(404);
      expect((await request("GET", path, { userId: editor.id })).status, path).toBe(200);
    }
  });
});
