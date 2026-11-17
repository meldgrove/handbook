import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newPageFile } from "@knowledge/shared/page";
import { getDb } from "../db/client";
import { pageLinks, pageRevisions, pageSections, pages } from "../db/schema";
import { createPage, createSpace, createUser, resetDatabase } from "../test/helpers";
import {
  createLivePage,
  deleteLivePage,
  lockPage,
  moveLivePage,
  PageConflictError,
  restoreDeletedPage,
  saveLivePage,
} from "./core";

const author = (userId: string) => ({ userId, via: "web" as const, clientName: null });

async function save(pageId: string, markdown: string, baseRevision: number, userId: string) {
  return getDb().transaction(async (tx) => {
    const page = await lockPage(tx, pageId);
    const [space] = await tx.query.spaces.findMany({
      where: (table, { eq: equals }) => equals(table.id, page.spaceId),
    });
    return saveLivePage(tx, { space: space!, page, markdown, baseRevision, author: author(userId) });
  });
}

describe("page core", () => {
  beforeEach(resetDatabase);

  it("stores canonical files, revisions, sections and links", async () => {
    const user = await createUser();
    const space = await createSpace({ slug: "it" });
    await createPage(space, { title: "Laptop", slug: "laptop" });
    const page = await createPage(space, {
      title: "VPN",
      markdown:
        "---\ntags: [Network, network]\ntitle:   VPN\n---\n\n\nIntro text.\n\n## Set up\n\nSee [the laptop](laptop) and [missing](missing-page).\n",
      authorId: user.id,
    });
    expect(page.path).toBe("vpn");
    expect(page.markdown).toBe(
      "---\ntitle: VPN\ntags:\n  - network\n---\n\nIntro text.\n\n## Set up\n\nSee [the laptop](laptop) and [missing](missing-page).\n",
    );
    const sections = await getDb().select().from(pageSections).where(eq(pageSections.pageId, page.id));
    expect(sections.map((section) => [section.anchor, section.headingPath])).toEqual([
      [null, []],
      ["set-up", ["Set up"]],
    ]);
    const links = await getDb().select().from(pageLinks).where(eq(pageLinks.fromPageId, page.id));
    expect(links.map((link) => [link.toPath, link.toPageId !== null]).sort()).toEqual([
      ["laptop", true],
      ["missing-page", false],
    ]);
    // A page created at a broken link's path makes it resolve.
    await createPage(space, { title: "Missing page" });
    const [resolved] = await getDb().select().from(pageLinks).where(eq(pageLinks.toPath, "missing-page"));
    expect(resolved?.toPageId).not.toBeNull();
  });

  it("merges changes that do not overlap and refuses those that do", async () => {
    const user = await createUser();
    const space = await createSpace();
    const page = await createPage(space, { title: "Doc", body: "one\n\ntwo\n\nthree\n" });
    const v1 = page.markdown;
    const first = await save(page.id, v1.replace("one", "ONE"), 1, user.id);
    expect(first.page.revision).toBe(2);
    const merged = await save(page.id, v1.replace("three", "THREE"), 1, user.id);
    expect(merged.merged).toBe(true);
    expect(merged.page.markdown).toContain("ONE");
    expect(merged.page.markdown).toContain("THREE");
    await expect(save(page.id, v1.replace("one", "uno"), 1, user.id)).rejects.toBeInstanceOf(
      PageConflictError,
    );
    const unchanged = await save(page.id, merged.page.markdown, 3, user.id);
    expect(unchanged.changed).toBe(false);
  });

  it("moves pages with sub-pages, keeps redirects, deletes and restores", async () => {
    const user = await createUser();
    const space = await createSpace();
    const parent = await createPage(space, { title: "Onboarding" });
    const child = await createPage(space, { title: "Laptop", parentPath: "onboarding" });
    await createPage(space, { title: "Guides" });
    await getDb().transaction(async (tx) => {
      const locked = await lockPage(tx, parent.id);
      await moveLivePage(tx, { space, page: locked, newPath: "guides/start", author: author(user.id) });
    });
    const [movedChild] = await getDb().select().from(pages).where(eq(pages.id, child.id));
    expect(movedChild?.path).toBe("guides/start/laptop");
    const kinds = await getDb()
      .select({ kind: pageRevisions.kind })
      .from(pageRevisions)
      .where(eq(pageRevisions.pageId, child.id));
    expect(kinds.map((row) => row.kind)).toEqual(["save", "move"]);

    await expect(
      getDb().transaction(async (tx) => {
        const locked = await lockPage(tx, parent.id);
        await deleteLivePage(tx, { space, page: locked, author: author(user.id) });
      }),
    ).rejects.toMatchObject({ code: "has_children" });

    await getDb().transaction(async (tx) => {
      const locked = await lockPage(tx, child.id);
      await deleteLivePage(tx, { space, page: locked, author: author(user.id) });
    });
    await getDb().transaction(async (tx) => {
      const locked = await lockPage(tx, child.id, { deleted: true });
      const restored = await restoreDeletedPage(tx, { space, page: locked, author: author(user.id) });
      expect(restored.deletedAt).toBeNull();
      expect(restored.revision).toBe(4);
    });
  });

  it("rejects invalid files and paths", async () => {
    const space = await createSpace({
      properties: [
        { key: "team", label: "Team", type: "select", options: ["it"], required: false, help: "" },
      ],
    });
    await expect(createPage(space, { title: "x", markdown: "no frontmatter" })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      createPage(space, {
        title: "x",
        markdown: newPageFile({ title: "Bad" }, { properties: [], pageTypes: [] }).replace(
          "title: Bad",
          "title: Bad\nteam: hr",
        ),
      }),
    ).rejects.toMatchObject({ fields: { "properties.team": "Use one of: it" } });
    await expect(createPage(space, { title: "Orphan", parentPath: "nowhere" })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      getDb().transaction((tx) =>
        createLivePage(tx, {
          space,
          parentPath: null,
          slug: "Not Valid",
          markdown: "---\ntitle: X\n---\n",
          author: author(""),
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});
