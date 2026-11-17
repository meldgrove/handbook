import { Hono } from "hono";
import { and, arrayContains, asc, eq, isNull, sql } from "drizzle-orm";
import { recentQuerySchema } from "@knowledge/shared/api/pages";
import { searchQuerySchema } from "@knowledge/shared/api/search";
import { normalizeTag } from "@knowledge/shared/page";
import { getDb } from "../db/client";
import { pages, spaces } from "../db/schema";
import type { AppEnv } from "../http/env";
import { queryOf, requirePrincipal } from "../http/middleware";
import { getSpace } from "../spaces/access";
import { searchPages } from "../search/query";
import { pageSummary, pageSummaryColumns, recentRevisions, visibleStatus } from "../pages/views";

const router = new Hono<AppEnv>();

router.get("/search", async (c) => {
  const principal = requirePrincipal(c);
  const query = queryOf(c, searchQuerySchema);
  return c.json({ results: await searchPages(getDb(), principal, query) });
});

router.get("/tags", async (c) => {
  const principal = requirePrincipal(c);
  const rows = await getDb()
    .select({ tag: sql<string>`unnest(${pages.tags})`.as("tag"), count: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(isNull(pages.deletedAt), visibleStatus(principal)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return c.json({ items: rows });
});

router.get("/tags/:tag/pages", async (c) => {
  const principal = requirePrincipal(c);
  const tag = normalizeTag(decodeURIComponent(c.req.param("tag")));
  const rows = await getDb()
    .select({ page: pageSummaryColumns, space: spaces.slug })
    .from(pages)
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    // @> (not = any) so the GIN index on tags finds the pages.
    .where(and(isNull(pages.deletedAt), visibleStatus(principal), arrayContains(pages.tags, [tag])))
    .orderBy(asc(pages.title));
  return c.json({ items: rows.map((row) => pageSummary(row.page, row.space)) });
});

router.get("/recent", async (c) => {
  const principal = requirePrincipal(c);
  const query = queryOf(c, recentQuerySchema);
  const spaceId = query.space ? (await getSpace(getDb(), query.space)).id : undefined;
  return c.json({ items: await recentRevisions(getDb(), principal, { spaceId, limit: query.limit }) });
});

export default router;
