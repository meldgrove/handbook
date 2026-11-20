import { and, eq, inArray, isNull, ne, or, sql, type Column, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { changeSetItems, pages, spaceMembers, spaces } from "../db/schema";
import type { Principal } from "../auth/principal";
import { notFound } from "../http/errors";
import { abilitiesOf, roleFrom, type SpaceContext } from "./access";

/**
 * What a principal may see of pages and change sets. Drafts, the trash and
 * change sets that change a draft are only for those whose abilities in the
 * space include `seeDrafts` (`spaceAbilities`, the only source of that
 * rule); every other live page is for everyone signed in. Lists and reads
 * of pages and change sets filter through here.
 */
export type Visibility = {
  /** SQL condition: the page is live (not in the trash) and the viewer may see it. */
  livePages(columns?: PageColumns): SQL;
  /** SQL condition on `change_sets`: it changes no draft the viewer may not see. */
  changeSets(): SQL;
  /** The viewer may see this page's status: drafts only where it sees drafts. */
  canSeePage(page: { spaceId: string; status: string }): boolean;
  /** 404 for a page whose status the viewer may not see. */
  assertPage(page: { spaceId: string; status: string }): void;
  /** True unless the change set changes a draft the viewer may not see (live or in the trash). */
  canSeeChangeSet(db: DbOrTx, changeSet: { id: string; spaceId: string }): Promise<boolean>;
  /** The viewer sees the drafts of this space. */
  seesDrafts(spaceId: string): boolean;
  /** The viewer sees the trash of this space (the same ability as drafts). */
  seesTrash(spaceId: string): boolean;
};

/**
 * The columns `livePages` reads; `pages` by default. Raw SQL that names the
 * table by an alias passes its own (`sql\`p.status\``).
 */
export type PageColumns = { spaceId: Column | SQL; status: Column | SQL; deletedAt: Column | SQL };

const PAGES: PageColumns = { spaceId: pages.spaceId, status: pages.status, deletedAt: pages.deletedAt };

/** Spaces whose drafts the viewer sees: all of them, or these. */
type DraftSpaces = "all" | ReadonlySet<string>;

function visibility(draftSpaces: DraftSpaces): Visibility {
  const ids = draftSpaces === "all" ? [] : [...draftSpaces];
  const seesDrafts = (spaceId: string) => draftSpaces === "all" || draftSpaces.has(spaceId);
  const canSeePage = (page: { spaceId: string; status: string }) =>
    page.status !== "draft" || seesDrafts(page.spaceId);
  return {
    livePages(columns = PAGES) {
      const live = isNull(columns.deletedAt);
      if (draftSpaces === "all") return live;
      const notDraft = ne(sql`${columns.status}`, "draft");
      return and(live, ids.length > 0 ? or(notDraft, inArray(sql`${columns.spaceId}`, ids)) : notDraft)!;
    },
    changeSets() {
      if (draftSpaces === "all") return sql`true`;
      // "change_sets" written out: inside the subquery an unqualified id would mean i.id or p.id.
      const noDrafts = sql`not exists (select 1 from change_set_items i join pages p on p.id = i.page_id
        where i.change_set_id = "change_sets"."id" and p.status = 'draft')`;
      if (ids.length === 0) return noDrafts;
      return sql`(${noDrafts} or "change_sets"."space_id" in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}))`;
    },
    canSeePage,
    assertPage(page) {
      if (!canSeePage(page)) throw notFound("No such page");
    },
    async canSeeChangeSet(db, changeSet) {
      if (seesDrafts(changeSet.spaceId)) return true;
      const [draft] = await db
        .select({ id: pages.id })
        .from(changeSetItems)
        .innerJoin(pages, eq(pages.id, changeSetItems.pageId))
        .where(and(eq(changeSetItems.changeSetId, changeSet.id), eq(pages.status, "draft")))
        .limit(1);
      return !draft;
    },
    seesDrafts,
    seesTrash: seesDrafts,
  };
}

/**
 * What the principal may see in every space, loaded once per request. With
 * the same abilities everywhere (admins: all drafts; service tokens: none)
 * it needs no query; otherwise it reads the principal's memberships and
 * asks `abilitiesOf` about each.
 */
export async function visibilityOf(db: DbOrTx, principal: Principal): Promise<Visibility> {
  // Without a role, seeing drafts does not depend on the space
  // (visibility.int.test.ts checks this in active and archived spaces).
  if (abilitiesOf(principal, null, { archivedAt: null }).seeDrafts) return visibility("all");
  // Service tokens have no role in any space (spaceRoleOf).
  if (principal.kind !== "user") return visibility(new Set());
  const rows = await db
    .select({ id: spaces.id, archivedAt: spaces.archivedAt, role: spaceMembers.role })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(eq(spaceMembers.userId, principal.id));
  const seen = rows.filter((row) => abilitiesOf(principal, roleFrom(row.role), row).seeDrafts);
  return visibility(new Set(seen.map((row) => row.id)));
}

/**
 * What the principal may see in one space, from the abilities of its
 * context (no query). Outside that space it shows no drafts.
 */
export function spaceVisibility(context: SpaceContext): Visibility {
  return visibility(new Set(context.abilities.seeDrafts ? [context.space.id] : []));
}
