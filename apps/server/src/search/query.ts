import { sql, type SQL } from "drizzle-orm";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  type SearchQuery,
  type SearchResult,
} from "@knowledge/shared/api/search";
import { normalizeTag } from "@knowledge/shared/page";
import { pageUrl } from "@knowledge/shared/paths";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import type { Principal } from "../auth/principal";

/**
 * Full-text search over live pages (docs/architecture.md, "Search"). Ranks
 * each page by its title, search terms, tags and description plus its best
 * matching section; returns the best section per page with a snippet.
 * Titles also match with trigram similarity, for typos.
 */

function tsQuery(text: string): SQL {
  return sql.join(
    config().searchConfigs.map((language) => sql`websearch_to_tsquery(${language}::regconfig, ${text})`),
    sql` || `,
  );
}

/** Drafts only for admins and the space's owners and editors. */
function draftFilter(principal: Principal): SQL {
  if (principal.kind === "service") return sql`p.status <> 'draft'`;
  if (principal.isAdmin) return sql`true`;
  return sql`(p.status <> 'draft' or exists (select 1 from space_members m where m.space_id = p.space_id and m.user_id = ${principal.id}))`;
}

function filters(query: SearchQuery): SQL {
  const parts: SQL[] = [sql`p.deleted_at is null`];
  if (query.space) parts.push(sql`sp.slug = ${query.space}`);
  if (query.tag) parts.push(sql`${normalizeTag(query.tag)} = any(p.tags)`);
  if (query.type) parts.push(sql`p.type = ${query.type}`);
  return sql.join(parts, sql` and `);
}

type Row = {
  id: string;
  path: string;
  title: string;
  description: string | null;
  tags: string[];
  type: string | null;
  space_slug: string;
  space_name: string;
  anchor: string | null;
  heading_path: string[] | null;
  snippet: string | null;
  score: number;
};

const HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_END}, MaxWords=35, MinWords=12, ShortWord=2, MaxFragments=1, FragmentDelimiter=" … "`;

function toResult(row: Row): SearchResult {
  const anchor = row.anchor ?? null;
  return {
    pageId: row.id,
    space: { slug: row.space_slug, name: row.space_name },
    path: row.path,
    title: row.title,
    description: row.description,
    headingPath: row.heading_path ?? [],
    anchor,
    url: `${config().APP_URL}${pageUrl(row.space_slug, row.path, anchor)}`,
    snippet: (row.snippet ?? "").trim(),
    tags: row.tags,
    type: row.type,
    score: Math.round(Number(row.score) * 1000) / 1000,
  };
}

export async function searchPages(
  db: DbOrTx,
  principal: Principal,
  query: SearchQuery,
): Promise<SearchResult[]> {
  const q = tsQuery(query.q);
  const headlineLanguage = config().searchConfigs[0]!;
  const ranked = await db.execute<Row>(sql`
    with q as (select ${q} as query)
    select p.id, p.path, p.title, p.description, p.tags, p.type, sp.slug as space_slug, sp.name as space_name,
      best.anchor, best.heading_path,
      ts_headline(${headlineLanguage}::regconfig,
        coalesce(best.content, nullif(p.description, ''), first.content, ''), q.query, ${HEADLINE_OPTIONS}) as snippet,
      (ts_rank(p.search_vector, q.query) * 2 + coalesce(best.rank, 0)) as score
    from pages p
    join spaces sp on sp.id = p.space_id
    cross join q
    left join lateral (
      select s.anchor, s.heading_path, s.content, ts_rank(s.search_vector, q.query) as rank
      from page_sections s
      where s.page_id = p.id and s.search_vector @@ q.query
      order by rank desc, s.position
      limit 1
    ) best on true
    left join lateral (
      select s.content from page_sections s where s.page_id = p.id order by s.position limit 1
    ) first on true
    where ${filters(query)} and ${draftFilter(principal)}
      and (p.search_vector @@ q.query or best.rank is not null)
    order by score desc, p.title
    limit ${query.limit}
  `);
  const results = ranked.rows.map(toResult);
  if (results.length >= query.limit) return results;

  // Typos: titles similar to the query that full-text search missed.
  const seen = results.map((result) => result.pageId);
  const similar = await db.execute<Row>(sql`
    select p.id, p.path, p.title, p.description, p.tags, p.type, sp.slug as space_slug, sp.name as space_name,
      null as anchor, null as heading_path,
      left(coalesce(nullif(p.description, ''), (select s.content from page_sections s where s.page_id = p.id order by s.position limit 1), ''), 240) as snippet,
      similarity(p.title, ${query.q}) * 0.5 as score
    from pages p
    join spaces sp on sp.id = p.space_id
    where ${filters(query)} and ${draftFilter(principal)}
      and similarity(p.title, ${query.q}) > 0.3
      ${
        seen.length > 0
          ? sql`and p.id not in (${sql.join(
              seen.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
    order by similarity(p.title, ${query.q}) desc, p.title
    limit ${query.limit - results.length}
  `);
  return [...results, ...similar.rows.map(toResult)];
}
