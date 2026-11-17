import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, type Tx } from "../db/client";
import { pages } from "../db/schema";
import { createPage, createSpace, resetDatabase } from "../test/helpers";
import { blockedOrDone, heldTransaction, settle } from "../test/concurrency";
import { createLivePage, deleteLivePage, lockPage, moveLivePage, restoreDeletedPage } from "./core";

/**
 * Writes that race each other, in a fixed order: the first transaction
 * holds its locks until the second one waits for them (or finished, when
 * nothing stopped it), then commits.
 */

const author = { userId: null, via: "web" as const, clientName: null };
const file = (title: string) => `---\ntitle: ${title}\n---\n`;

type Space = Awaited<ReturnType<typeof createSpace>>;

const create = (tx: Tx, space: Space, parentPath: string, slug: string) =>
  createLivePage(tx, { space, parentPath, slug, markdown: file(slug), author });

async function move(tx: Tx, space: Space, pageId: string, newPath: string) {
  const page = await lockPage(tx, pageId);
  return moveLivePage(tx, { space, page, newPath, author });
}

async function trash(tx: Tx, space: Space, pageId: string) {
  const page = await lockPage(tx, pageId);
  await deleteLivePage(tx, { space, page, author });
}

async function restore(tx: Tx, space: Space, pageId: string) {
  const page = await lockPage(tx, pageId, { deleted: true });
  return restoreDeletedPage(tx, { space, page, author });
}

/** Runs `first` and holds it open while `second` starts; then commits `first`. */
async function race<A, B>(first: (tx: Tx) => Promise<A>, second: (tx: Tx) => Promise<B>) {
  const held = heldTransaction(first);
  await held.ready;
  const next = settle(getDb().transaction(second));
  expect(await blockedOrDone(next)).toBe("blocked");
  await held.commit();
  return next;
}

async function pageAt(id: string) {
  const [row] = await getDb().select().from(pages).where(eq(pages.id, id));
  return row!;
}

describe("page core races", () => {
  beforeEach(resetDatabase);

  it("moves a sub-page created while its parent moves along with it", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const held = heldTransaction((tx) => create(tx, space, "a", "new"));
    await held.ready;
    const moving = settle(getDb().transaction((tx) => move(tx, space, a.id, "z")));
    expect(await blockedOrDone(moving)).toBe("blocked");
    const created = await held.commit();
    expect((await moving).ok).toBe(true);
    expect(await pageAt(created.id)).toMatchObject({ path: "z/new", parentId: a.id });
  });

  it("moves a page created two levels below a page that moves", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    await createPage(space, { title: "B", parentPath: "a", slug: "b" });
    const held = heldTransaction((tx) => create(tx, space, "a/b", "new"));
    await held.ready;
    const moving = settle(getDb().transaction((tx) => move(tx, space, a.id, "z")));
    expect(await blockedOrDone(moving)).toBe("blocked");
    const created = await held.commit();
    expect((await moving).ok).toBe(true);
    expect((await pageAt(created.id)).path).toBe("z/b/new");
  });

  it("refuses a sub-page below a page that moved meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const result = await race(
      (tx) => move(tx, space, a.id, "z"),
      (tx) => create(tx, space, "a", "new"),
    );
    expect(result).toMatchObject({ ok: false, error: { status: 422 } });
    expect((await getDb().select().from(pages)).map((row) => row.path)).toEqual(["z"]);
  });

  it("refuses to delete a page that got a sub-page meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const result = await race(
      (tx) => create(tx, space, "a", "new"),
      (tx) => trash(tx, space, a.id),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "has_children" } });
    expect((await pageAt(a.id)).deletedAt).toBeNull();
  });

  it("refuses to move a page below a page deleted meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const x = await createPage(space, { title: "X", slug: "x" });
    const result = await race(
      (tx) => trash(tx, space, a.id),
      (tx) => move(tx, space, x.id, "a/x"),
    );
    expect(result).toMatchObject({ ok: false, error: { status: 422 } });
    expect((await pageAt(x.id)).path).toBe("x");
  });

  it("refuses to restore a page below a page that moved meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const child = await createPage(space, { title: "C", parentPath: "a", slug: "c" });
    await getDb().transaction((tx) => trash(tx, space, child.id));
    const result = await race(
      (tx) => move(tx, space, a.id, "z"),
      (tx) => restore(tx, space, child.id),
    );
    expect(result).toMatchObject({ ok: false, error: { status: 422 } });
    expect((await pageAt(child.id)).deletedAt).not.toBeNull();
  });
});
