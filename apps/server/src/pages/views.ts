import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Actor } from "@handbook/shared/api/common";
import type {
  LockHolder,
  Page,
  PageRef,
  PageSummary,
  Revision,
  RevisionSummary,
} from "@handbook/shared/api/pages";
import { LOCK_EXPIRE_SECONDS, LOCK_IDLE_SECONDS } from "@handbook/shared/limits";
import { pageStatusSchema } from "@handbook/shared/page";
import { viaSchema } from "@handbook/shared/roles";
import type { DbOrTx } from "../db/client";
import {
  changeSetItems,
  changeSets,
  drafts,
  editLocks,
  pageLinks,
  pageRevisions,
  pages,
  spaceMembers,
  spaces,
  users,
} from "../db/schema";
import type { Principal } from "../auth/principal";
import { notFound } from "../http/errors";
import type { SpaceContext } from "../spaces/access";
import { bodyOf, type PageRow } from "./core";

export const iso = (value: Date) => value.toISOString();

type UserRow = { id: string; name: string; email: string } | null | undefined;

export function actorOf(user: UserRow): Actor | null {
  if (!user) return null;
  return { id: user.id, name: user.name || user.email, email: user.email };
}

/** The columns a page summary needs: lists and trees never load the file or its search data. */
export const pageSummaryColumns = {
  id: pages.id,
  path: pages.path,
  parentId: pages.parentId,
  position: pages.position,
  title: pages.title,
  description: pages.description,
  status: pages.status,
  type: pages.type,
  tags: pages.tags,
  revision: pages.revision,
  updatedAt: pages.updatedAt,
};

export type PageSummaryRow = Pick<PageRow, keyof typeof pageSummaryColumns>;

export function pageSummary(row: PageSummaryRow, spaceSlug: string): PageSummary {
  return {
    id: row.id,
    space: spaceSlug,
    path: row.path,
    parentId: row.parentId,
    position: row.position,
    title: row.title,
    description: row.description,
    status: pageStatusSchema.catch("active").parse(row.status),
    type: row.type,
    tags: row.tags,
    revision: row.revision,
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * SQL condition: the principal may see this page's status. Drafts only for
 * admins and the owners and editors of the page's space.
 */
export function visibleStatus(principal: Principal): SQL {
  if (principal.kind === "service") return ne(pages.status, "draft");
  if (principal.isAdmin) return sql`true`;
  // "pages"."space_id" with the table name: Drizzle leaves column names
  // unqualified in single-table selects, and inside the subquery an
  // unqualified space_id would mean m.space_id (true for any membership).
  return or(
    ne(pages.status, "draft"),
    sql`exists (select 1 from ${spaceMembers} m where m.space_id = "pages"."space_id" and m.user_id = ${principal.id})`,
  )!;
}

/** 404 for a draft the principal may not see. */
export function assertVisible(context: SpaceContext, page: PageRow) {
  if (page.status === "draft" && !context.abilities.seeDrafts) throw notFound("No such page");
}

/** SQL condition: an edit lock is still valid (renewed recently, typed recently). */
export function lockIsValid(): SQL {
  return sql`${editLocks.renewedAt} > now() - make_interval(secs => ${LOCK_EXPIRE_SECONDS}) and ${editLocks.activityAt} > now() - make_interval(secs => ${LOCK_IDLE_SECONDS})`;
}

export function lockExpired(lock: { renewedAt: Date; activityAt: Date }, now = Date.now()): boolean {
  return (
    now - lock.renewedAt.getTime() > LOCK_EXPIRE_SECONDS * 1000 ||
    now - lock.activityAt.getTime() > LOCK_IDLE_SECONDS * 1000
  );
}

export async function currentLock(
  tx: DbOrTx,
  pageId: string,
  viewerId: string | null,
): Promise<LockHolder | null> {
  const [row] = await tx
    .select({ lock: editLocks, user: { id: users.id, name: users.name, email: users.email } })
    .from(editLocks)
    .innerJoin(users, eq(users.id, editLocks.userId))
    .where(and(eq(editLocks.pageId, pageId), lockIsValid()));
  if (!row) return null;
  return { user: actorOf(row.user)!, since: iso(row.lock.acquiredAt), mine: row.lock.userId === viewerId };
}

/** The pages of a path's ancestors, top first. */
async function breadcrumbs(tx: DbOrTx, context: SpaceContext, path: string): Promise<PageRef[]> {
  const { space, abilities } = context;
  const segments = path.split("/");
  const prefixes = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  if (prefixes.length === 0) return [];
  const rows = await tx
    .select({ id: pages.id, path: pages.path, title: pages.title })
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, space.id),
        inArray(pages.path, prefixes),
        isNull(pages.deletedAt),
        // An active child can still have a draft ancestor.
        abilities.seeDrafts ? undefined : ne(pages.status, "draft"),
      ),
    );
  return rows
    .sort((a, b) => a.path.length - b.path.length)
    .map((row) => ({ id: row.id, space: space.slug, path: row.path, title: row.title }));
}

/** A page with its context, as the page API returns it. */
export async function pageView(
  tx: DbOrTx,
  principal: Principal,
  context: SpaceContext,
  page: PageRow,
): Promise<Page> {
  const { space, abilities } = context;
  const viewerId = principal.kind === "user" ? principal.id : null;
  const children = await tx
    .select(pageSummaryColumns)
    .from(pages)
    .where(
      and(
        eq(pages.parentId, page.id),
        isNull(pages.deletedAt),
        abilities.seeDrafts ? sql`true` : ne(pages.status, "draft"),
      ),
    )
    .orderBy(asc(pages.position), asc(pages.title));
  const backlinkRows = await tx
    .selectDistinct({ id: pages.id, path: pages.path, title: pages.title, space: spaces.slug })
    .from(pageLinks)
    .innerJoin(pages, eq(pages.id, pageLinks.fromPageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .where(and(eq(pageLinks.toPageId, page.id), isNull(pages.deletedAt), visibleStatus(principal)))
    .orderBy(asc(pages.title));
  const [updatedBy] = page.updatedById
    ? await tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, page.updatedById))
    : [];
  const [draft] = viewerId
    ? await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.pageId, page.id), eq(drafts.userId, viewerId)))
    : [];
  const openChangeSets = await tx
    .select({ number: changeSets.number, title: changeSets.title, status: changeSets.status })
    .from(changeSetItems)
    .innerJoin(changeSets, eq(changeSets.id, changeSetItems.changeSetId))
    .where(and(eq(changeSetItems.pageId, page.id), inArray(changeSets.status, ["open", "in_review"])))
    .orderBy(desc(changeSets.number));
  return {
    ...pageSummary(page, space.slug),
    spaceName: space.name,
    markdown: page.markdown,
    body: bodyOf(page.markdown),
    properties: page.properties,
    createdAt: iso(page.createdAt),
    updatedBy: actorOf(updatedBy),
    breadcrumbs: await breadcrumbs(tx, context, page.path),
    children: children.map((child) => pageSummary(child, space.slug)),
    backlinks: backlinkRows.map((row) => ({
      id: row.id,
      space: row.space,
      path: row.path,
      title: row.title,
    })),
    lock: await currentLock(tx, page.id, viewerId),
    draft: draft ? { baseRevision: draft.baseRevision, updatedAt: iso(draft.updatedAt) } : null,
    changeSets: openChangeSets,
    abilities,
  };
}

/** A revision without its file: lists never load the text. */
const revisionColumns = {
  revision: {
    number: pageRevisions.number,
    kind: pageRevisions.kind,
    path: pageRevisions.path,
    title: pageRevisions.title,
    via: pageRevisions.via,
    clientName: pageRevisions.clientName,
    message: pageRevisions.message,
    added: pageRevisions.added,
    removed: pageRevisions.removed,
    createdAt: pageRevisions.createdAt,
  },
  author: { id: users.id, name: users.name, email: users.email },
  changeSet: { number: changeSets.number, title: changeSets.title },
};

type RevisionRow = {
  revision: Pick<typeof pageRevisions.$inferSelect, keyof typeof revisionColumns.revision>;
  author: UserRow;
  changeSet: { number: number; title: string } | null;
};

export function revisionSummary(row: RevisionRow): RevisionSummary {
  const revision = row.revision;
  return {
    number: revision.number,
    kind: revision.kind as RevisionSummary["kind"],
    path: revision.path,
    title: revision.title,
    author: actorOf(row.author),
    via: viaSchema.catch("web").parse(revision.via),
    clientName: revision.clientName,
    changeSet: row.changeSet?.number ? row.changeSet : null,
    message: revision.message,
    added: revision.added,
    removed: revision.removed,
    createdAt: iso(revision.createdAt),
  };
}

function revisionQuery(tx: DbOrTx) {
  return tx
    .select(revisionColumns)
    .from(pageRevisions)
    .leftJoin(users, eq(users.id, pageRevisions.authorId))
    .leftJoin(changeSets, eq(changeSets.id, pageRevisions.changeSetId));
}

/** A page's revisions, newest first, one page of the list at a time. */
export async function listRevisions(
  tx: DbOrTx,
  pageId: string,
  options: { limit: number; offset: number },
): Promise<{ items: RevisionSummary[]; total: number }> {
  const [rows, [total]] = await Promise.all([
    revisionQuery(tx)
      .where(eq(pageRevisions.pageId, pageId))
      .orderBy(desc(pageRevisions.number))
      .limit(options.limit)
      .offset(options.offset),
    tx.select({ value: count() }).from(pageRevisions).where(eq(pageRevisions.pageId, pageId)),
  ]);
  return { items: rows.map(revisionSummary), total: total?.value ?? 0 };
}

export async function getRevision(tx: DbOrTx, pageId: string, number: number): Promise<Revision> {
  const [row] = await revisionQuery(tx).where(
    and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.number, number)),
  );
  if (!row) throw notFound("No such revision");
  // The file of this revision and of the one before it, for a diff.
  const files = await tx
    .select({ number: pageRevisions.number, markdown: pageRevisions.markdown })
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, pageId), inArray(pageRevisions.number, [number, number - 1])));
  const fileOf = (wanted: number) => files.find((file) => file.number === wanted)?.markdown ?? null;
  return {
    ...revisionSummary(row),
    markdown: fileOf(number) ?? "",
    previousMarkdown: fileOf(number - 1),
  };
}

/** Recent revisions of visible live pages, newest first. */
export async function recentRevisions(
  tx: DbOrTx,
  principal: Principal,
  options: { spaceId?: string; limit: number },
) {
  const rows = await tx
    .select({
      ...revisionColumns,
      page: { id: pages.id, path: pages.path, title: pages.title },
      space: spaces.slug,
    })
    .from(pageRevisions)
    .innerJoin(pages, eq(pages.id, pageRevisions.pageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .leftJoin(users, eq(users.id, pageRevisions.authorId))
    .leftJoin(changeSets, eq(changeSets.id, pageRevisions.changeSetId))
    .where(
      and(
        isNull(pages.deletedAt),
        visibleStatus(principal),
        options.spaceId ? eq(pages.spaceId, options.spaceId) : sql`true`,
      ),
    )
    .orderBy(desc(pageRevisions.createdAt), desc(pageRevisions.number))
    .limit(options.limit);
  return rows.map((row) => ({
    page: { id: row.page.id, space: row.space, path: row.page.path, title: row.page.title },
    revision: revisionSummary(row),
  }));
}
