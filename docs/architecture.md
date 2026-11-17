# Architecture

How Meldgrove Knowledge works inside, for contributors. `AGENTS.md` has the
code rules; `docs/agents.md` explains agent access for people who connect
agents.

## Concepts

- **Space**: one knowledge base (e.g. "IT", "People & Culture"). Everyone
  signed in reads every space. Owners and editors are set in the app.
- **Page**: one Markdown file with YAML frontmatter, in a tree inside its
  space. Its **path** is its slugs joined by `/` (`onboarding/laptop`); its
  URL is `/s/<space>/<path>`, its file `/s/<space>/<path>.md`.
- **Properties**: the frontmatter. Built-in keys (`title`, `description`,
  `type`, `status`, `tags`, `owner`, `reviewed`, `replaced_by`,
  `search_terms`) plus custom properties each space defines, with types.
  **Page types** add a template and required properties.
- **Revision**: every change of a page (save, move, delete, restore) is a
  numbered revision with the full file, author, channel and change set.
- **Change set**: the app's branch and pull request. Changes to pages of one
  space that stay invisible until an editor merges them. Agents always work
  in change sets; staff without edit rights suggest changes with them.
- **Edit lock**: while someone edits a page in the web editor, others
  cannot open the editor. Locks expire; editors can take them over.

## Roles

`packages/shared/src/roles.ts` (`spaceAbilities`) decides, for every channel:

| Who                                             | May                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Everyone signed in                              | Read every space (drafts only when editor); suggest changes (change sets); comment.                                 |
| Space editor                                    | Also edit pages live; review, merge, close and revert change sets.                                                  |
| Space owner                                     | Also: space settings, editors, properties, page types.                                                              |
| Admin (`ADMIN_EMAILS` or made admin in the app) | Everything in every space; create and archive spaces; choose owners; people, service tokens, audit log.             |
| Agent: personal token or connected app (OAuth)  | Reads everything; writes only into change sets, even when its person is an editor; never merges, never administers. |
| Service token                                   | Reads only (search, pages, Markdown files).                                                                         |

Archived spaces are read-only: no page changes, change sets, comments or
status changes.

## Processes

One Docker image, one Node.js entry point (`apps/server/src/main.ts`);
`APP_ROLE` picks what runs:

- **web**: the Hono server: the JSON API under `/api/v1`, sign-in under
  `/api/auth` (Better Auth), the OAuth server for connected apps under
  `/.well-known/*` and `/oauth/*`, the MCP endpoint `/mcp`, files under
  `/files/*`, Markdown files `/s/<space>/<path>.md`, `/s/<space>.md` and
  `/llms.txt`, health checks under `/-/`, and the built web app.
- **worker**: rebuilds the search index when `SEARCH_LANGUAGES` changed
  (one page per transaction, so saves go on meanwhile) and removes expired
  locks, OAuth requests and tokens, OAuth clients that never got a grant
  (after 3 days), unused uploads, and audit log entries older than
  `AUDIT_LOG_DAYS`.
- **migrate**: applies the Drizzle migrations under an advisory lock.
- **all**: web and worker in one process.

## Data

PostgreSQL holds everything except uploaded files (`FILES_DIR`).

- `users` (+ Better Auth's `sessions`, `accounts`, `verifications`,
  `auth_rate_limits`): everyone who signed in or was named as editor;
  `is_admin`, `admin_source` (`environment` or `app`), `blocked_at`.
- `spaces`, `space_members` (owner or editor).
- `pages`: the live version of each page. Columns derived from the file on
  every save (title, status, type, tags, search terms, properties, the file
  itself as `markdown`, `search_vector`). `deleted_at` puts it in the trash.
- `page_revisions`: every version: number, kind (save, move, delete,
  restore), path and title then, the whole file, author, `via` (web, api,
  mcp, import, merge, revert, restore), `client_name`, `change_set_id`,
  added and removed lines.
- `page_sections`: live pages split at headings, with anchors and heading
  paths, for search. `page_links`: links between pages (backlinks, broken
  links). `redirects`: old paths of moved pages.
- `files`: uploads, stored under `FILES_DIR` with generated names.
- `edit_locks`, `drafts`: the web editor's locks and unsaved text.
- `change_sets`, `change_set_items` (one per page), `change_set_events` (the
  timeline: edits, comments, status changes).
- `credentials`: SHA-256 hashes of personal tokens, service tokens and the
  OAuth access and refresh tokens. `oauth_clients`, `oauth_grants` (a
  person's consent for an app), `oauth_requests` (pending sign-ins).
- `settings` (app state, e.g. the search languages of the index),
  `audit_log` (admin and owner changes).

## Page files

`packages/shared/src/page.ts` parses, validates and writes page files; the
server, the web editor and agents use it. Every save stores the **canonical
form**: frontmatter keys in a fixed order (built-ins, then custom keys in
the space's order), empty values left out, tags lowercase, Unix line
endings, no blank lines at the start of the body, one newline at the end.
The body itself is kept as written, so diffs show real changes only.

A file without frontmatter or with unknown keys is refused with field
errors (`properties.<key>`). Unknown keys must be defined in the space
first; imports can define them (owners).

Markdown is CommonMark with GitHub's extensions (tables, task lists,
strikethrough, autolinks) and GitHub callouts (`> [!NOTE]`, `[!TIP]`,
`[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`). HTML in a page is shown as
text, never run.

## The page core

`apps/server/src/pages/core.ts` is the one write path. Callers check
permissions, then call it inside a transaction with a page locked by
`lockPage`:

- `saveLivePage`: canonical form; when the page changed since
  `baseRevision`, a three-way merge (`packages/shared/src/merge.ts`) combines
  both changes; overlapping changes throw `PageConflictError` (409
  `page_changed`, with the current file and a merged text with conflict
  blocks). Saving the same file again changes nothing.
- `createLivePage`, `moveLivePage` (with sub-pages; old paths redirect; each
  moved page gets a `move` revision), `deleteLivePage` (to the trash; pages
  with live sub-pages cannot be deleted), `restoreDeletedPage`. A page put
  below another locks that parent and its ancestors (shared) until the
  transaction ends, so none of them moves or goes to the trash meanwhile.
- Saves and new pages lock their space (shared) and check the file against
  its properties and page types as they are then; a change of those
  (`updateSpace`) locks the space and checks every live page.
- After every write it rebuilds the page's search sections, search vector
  and links, and resolves links that pointed at the page's path (on
  restore also its old paths).

Change set merges, imports (through change sets), restores and the REST API
all use these functions.

## Links

Links are ordinary Markdown links (`packages/shared/src/paths.ts`,
`resolveLink`): `/s/<space>/<path>` or relative like files (`vpn`,
`../policies/ai`, `setup/index.md`; `.md` and `/index` are ignored). The
server stores each live page's outgoing links in `page_links`, resolved to
pages through live paths and redirects; the web app resolves them the same
way when it renders. A moved page's old path keeps working through
`redirects` (the page API answers with the page's current path).

## Edit locks and drafts

Times in `packages/shared/src/limits.ts`.

1. Opening the web editor takes the page's lock (`POST /pages/:id/lock`)
   and gets a token. The editor renews it every 30 seconds with
   `active: true` when the person typed since.
2. Someone else who opens the editor gets 423 `page_locked` with the holder
   and since when; they can read, or (editors) take the lock over.
3. A lock ends on save or cancel, 2 minutes after the last renewal, or 30
   minutes after the last typing. The same person opening the editor in
   another tab takes the lock from the first tab.
4. A takeover replaces the token; the previous editor's next renewal gets
   409 `lock_lost` with who took it, and its text stays in its draft.
5. The editor stores unsaved text as a draft every 5 seconds (per person
   and page) and offers it when the person opens the editor again. Drafts
   of a page in the trash stay and come back with it.
6. Every save sends `baseRevision`; the page core merges or answers 409
   `page_changed` (see above). The editor then shows the merged text with
   conflict blocks; saving is refused while blocks remain.

Agents never take locks: they work in change sets.

## Change sets

Statuses: `open → in_review → merged`, or `closed` (and back to `open`).

- **Items**: one per page: `create` (new page; `page_id` is the id the page
  gets at merge), `update` (new file and/or new path; `base_revision` is the
  live revision when the change set first touched the page), `delete`.
  Changing a new page again updates its `create` item; deleting a page the
  change set created removes the item.
- **Reading inside a change set**: a page is the item's version if the
  change set has one, else the live page. Paths resolve the same way (a
  `create` item's path, else live paths not deleted or moved away).
- **Who may change it**: its author and the space's editors, while open or
  in review. Every change records an `edited` event.
- **Submit** (author or editors) → `in_review`. **Request changes**
  (editors, with a comment) → `open`. **Merge** (editors; not agents) from
  `open` or `in_review`. **Close** (author or editors), **reopen** (author or
  editors).
- **Checks** (shown on the change set; errors block merging): files valid
  against the space now; parents exist; no two pages with one path; no
  conflict blocks left; the live page changed in overlapping ways
  (`conflict`). Warnings: links to pages that will not exist.
- **Merge**: one transaction. Creates first (parents before children), then
  updates and moves (each through `saveLivePage` with the item's
  `base_revision`, so changes saved meanwhile are merged), then deletes
  (children first; a page already in the trash stays there). Any overlap
  aborts the merge with 409 `merge_conflicts`; "Update from live" on an
  item rebases it (`base_revision` = live, the file merged, with conflict
  blocks to resolve). Revisions get `via = merge` and the change set id; the
  author is the person who made the item.
- **Revert** (editors, merged change sets): a new change set "Revert …"
  that restores each page to its revision before the merge (three-way merged
  with later changes), deletes pages the change set created or took out of
  the trash, and restores pages it deleted. One transaction: it is merged at
  once when there are no conflicts, else it stays open (reverting again
  answers with it); any other failure leaves no revert behind. A page
  restored live before the revert is merged keeps the changes saved since.

## Search

`apps/server/src/search/`. PostgreSQL full-text search over
`SEARCH_LANGUAGES` (stemming per language) plus `simple` (exact words).

- Pages: title (weight A), search terms and tags (B), description (C).
  Sections: heading path (A), text (D).
- A query ranks sections with their page's rank, keeps the best section per
  page, and returns a snippet (`ts_headline`) with matched words between
  `HIGHLIGHT_START` and `HIGHLIGHT_END`. Titles also match with a trigram
  similarity (`pg_trgm`) for typos.
- Drafts only appear for editors of their space; deleted pages never.

## Files

`POST /api/v1/spaces/:space/files` stores an upload (up to
`MAX_UPLOAD_MB`) and returns its URL `/files/<id>/<name>` and a Markdown
snippet. `GET /files/<id>/<name>` serves it to anyone signed in: PNG, JPEG,
GIF and WebP inline, everything else (including SVG) as a download, always
with `X-Content-Type-Options: nosniff` and a sandboxing CSP. The worker
removes uploads older than a day that no page, revision or change set
mentions.

## Import and export

- **Export** (`GET /api/v1/spaces/:space/export`): a zip with one file per
  live page (`<path>.md`, sub-pages in folders named like the page) and
  `_space.yaml` (name, description, properties, page types, page order).
  Readers get no drafts.
- **Import** (`POST /api/v1/spaces/:space/import`, editors): a zip of
  Markdown files becomes one change set (created and updated pages) to
  review and merge. `x/index.md` and `x.md` both become page `x`; folders
  without a file get a page titled after the folder. Files and folders
  starting with `_` or `.` are skipped (except `_space.yaml`). Frontmatter
  conventions of other tools are mapped: `page_type` → `type`; `slug`,
  `last_updated` are dropped. Keys the space does not define are dropped
  and listed, or, for owners with `defineProperties`, added to the space
  (text, list, number, yes/no or date, from the values). VitePress boxes
  (`::: tip`, `info`, `warning`, `danger`, `details`) become callouts; heading
  anchors `{#id}` are removed. Limits: `MAX_IMPORT_BYTES`, `MAX_IMPORT_FILES`.

## Agents

### Credentials

`apps/server/src/auth/credentials.ts`. Tokens are random, prefixed by kind
(`kn_pat_`, `kn_svc_`, `kn_at_`, `kn_rt_`) and stored as SHA-256 hashes. A
request with `Authorization: Bearer` is authenticated by the token only
(cookies are ignored, so cross-site checks do not apply).

- Personal tokens: created by a person in the web app (Settings); the agent
  acts as that person with agent limits. Optional expiry.
- Service tokens: created by admins; read-only.
- Connected apps: OAuth access tokens (60 minutes by default) and rotating
  refresh tokens (30 days), tied to a grant the person can revoke.

### OAuth server

`apps/server/src/oauth/`, for MCP clients (Claude, ChatGPT, Langdock,
Claude Code, …), following the MCP authorization specification:

- `GET /.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp`: the resource `<APP_URL>/mcp`
  and this server as its authorization server.
- `GET /.well-known/oauth-authorization-server`: endpoints, `S256` PKCE
  only, grant types `authorization_code` and `refresh_token`,
  `token_endpoint_auth_methods_supported: none, client_secret_post,
client_secret_basic`, `client_id_metadata_document_supported: true`.
- `POST /oauth/register`: dynamic client registration (RFC 7591).
  Redirect URIs must be `https`, `http` on `localhost`, `127.0.0.1` or
  `[::1]` (any port), or a native app's own scheme (RFC 8252, e.g. Cursor's
  `cursor://anysphere.cursor-mcp/oauth/callback`); `javascript:`, `data:`,
  `file:` and similar schemes are refused.
- Client metadata documents: a `client_id` that is an `https` URL is
  fetched (5 seconds, 64 KB, JSON, no redirects, never private or loopback
  addresses unless `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`), must name itself as
  `client_id` and list the `redirect_uri`; cached for an hour. One fetch
  at a time per `client_id` and at most 8 at once per process; beyond that,
  the sign-in page asks to try again.
- `GET /oauth/authorize`: checks client, redirect URI, `code_challenge`
  (S256), `resource` (must be the MCP URL when given); stores a request
  (10 minutes) and sends the browser to the sign-in page if needed, then to
  the consent screen `/oauth/consent?request=<id>` in the web app. Every
  problem shows an error page: anyone can register a redirect URI, so the
  browser goes back to the app only after the person decided (RFC 9700
  4.11.2, no open redirect). Approve or deny there
  (`/api/v1/oauth/requests/:id/approve|deny`) returns the redirect with
  `code` and `state`, or `error=access_denied`.
- The consent screen shows the app's name as the app's own claim: the
  host of its metadata document when it has one, "Not verified" when it
  registered itself, and where the browser returns (the host; with the
  scheme when it is not `https`). It shows no link from `client_uri`.
- `POST /oauth/token`: `authorization_code` (one use, PKCE checked,
  `redirect_uri` must match) and `refresh_token` (rotating: the old refresh
  token stops working). A used code or a replaced refresh token presented
  again revokes every token of its grant: someone may have stolen it.
  Responses `Cache-Control: no-store`.
- `POST /oauth/revoke` (RFC 7009).
- Rate limits per client address (`X-Forwarded-For` behind `TRUST_PROXY`;
  IPv6 by /64 network), as token buckets in memory, so each web process
  counts on its own: `/oauth/register` 30 at once, then 2 per minute;
  `/oauth/authorize` 30, then 10; `/oauth/token` 60, then 60;
  `/oauth/revoke` 30, then 30 (`apps/server/src/oauth/rate-limit.ts`).
  Beyond: 429 with `Retry-After` (an error page for `/oauth/authorize`).
- `/mcp` without a valid token answers 401 with
  `WWW-Authenticate: Bearer resource_metadata="<APP_URL>/.well-known/oauth-protected-resource/mcp"`.
- CORS: the well-known documents, `/oauth/register`, `/oauth/token`,
  `/oauth/revoke` and `/mcp` allow any origin without cookies.

### MCP server

`apps/server/src/mcp/`: Streamable HTTP, stateless (every POST gets a new
server; JSON responses; GET and DELETE answer 405). Tools call the same
services as the REST API with the caller's principal. Read tools carry
`readOnlyHint`. Tools: `search`, `fetch`, `list_spaces`, `list_pages`,
`get_space_schema`, `read_page`, `page_history`, `read_revision`,
`list_change_sets`, `start_change_set`, `get_change_set`, `create_page`,
`edit_page`, `write_page`, `move_page`, `delete_page`, `undo_page_change`,
`comment_on_change_set`, `submit_change_set`. Pages are named by
`<space>/<path>` or id; parameters are snake_case (`change_set`,
`old_text`). The server's instructions explain the change set workflow.
Changes to a change set answer with the whole change set.

## REST API

All under `/api/v1`, JSON, contracts in `packages/shared/src/api/`. Errors:
`{ error: { code, message, fields? } }` plus extra fields for 409 and 423.

| Area        | Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Meta        | `GET /auth-config`, `GET /me`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Spaces      | `GET /spaces`, `POST /spaces` (admin), `GET /spaces/:space`, `PATCH /spaces/:space` (owner), `POST /spaces/:space/archive`, `/unarchive` (admin), `GET /spaces/:space/members`, `PUT /spaces/:space/members` (owner; owners: admin), `DELETE /spaces/:space/members/:userId`, `GET /spaces/:space/tree`, `GET /spaces/:space/trash`, `GET /spaces/:space/export`, `POST /spaces/:space/import`, `POST /spaces/:space/files`                                              |
| Pages       | `GET /spaces/:space/pages/by-path?path=`, `POST /spaces/:space/pages`, `GET /pages/:id`, `PUT /pages/:id`, `POST /pages/:id/move`, `DELETE /pages/:id`, `POST /pages/:id/restore`, `GET /pages/:id/revisions`, `GET /pages/:id/revisions/:number`, `POST /pages/:id/revisions/:number/restore`, `POST /pages/:id/lock`, `POST /pages/:id/lock/renew`, `POST /pages/:id/lock/takeover`, `DELETE /pages/:id/lock?token=`, `GET`/`PUT`/`DELETE /pages/:id/draft`            |
| Search      | `GET /search`, `GET /tags`, `GET /tags/:tag/pages`, `GET /recent`                                                                                                                                                                                                                                                                                                                                                                                                        |
| Change sets | `GET /change-sets`, `POST /change-sets`, `GET /change-sets/:number`, `PATCH /change-sets/:number`, `GET /change-sets/:number/pages/:pageId`, `GET /change-sets/:number/pages/by-path?path=`, `PUT /change-sets/:number/pages`, `POST /change-sets/:number/pages/:pageId/edit`, `/move`, `/delete`, `/rebase`, `DELETE /change-sets/:number/pages/:pageId`, `POST /change-sets/:number/comments`, `/submit`, `/request-changes`, `/merge`, `/close`, `/reopen`, `/revert` |
| Tokens      | `GET`/`POST /tokens`, `DELETE /tokens/:id`, `GET /connected-apps`, `DELETE /connected-apps/:id`, `GET /connect-info`, `GET /oauth/requests/:id`, `POST /oauth/requests/:id/approve`, `/deny`                                                                                                                                                                                                                                                                             |
| Admin       | `GET /admin/people`, `PATCH`/`DELETE /admin/people/:id`, `GET`/`POST /admin/service-tokens`, `DELETE /admin/service-tokens/:id`, `POST /admin/tags/rename`, `GET /admin/audit`                                                                                                                                                                                                                                                                                           |

## Web app

`apps/web/src/modules/<area>/` (`routes.tsx` registers its routes in
`modules/index.ts`):

| Route                                                                                                                                 | Module       |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `/` home: spaces, recent changes, change sets waiting for the person                                                                  | home         |
| `/s/$space` space home, `/s/$space/-/new`, `/s/$space/-/settings`, `/s/$space/-/trash` (no page path starts with `-`)                 | spaces       |
| `/s/$space/$` page, `/pages/$id/edit` (`?changeSet=<number>` or `new` to suggest), `/pages/$id/history`, `/pages/$id/history/$number` | pages        |
| `/search`, `/tags`, `/tags/$tag`                                                                                                      | search       |
| `/changes`, `/changes/$number`                                                                                                        | changes      |
| `/settings`: personal tokens, connected apps, how to connect agents                                                                   | settings     |
| `/oauth/consent` (outside the app layout)                                                                                             | oauth        |
| `/admin/spaces`, `/admin/people`, `/admin/service-tokens`, `/admin/audit`                                                             | admin, audit |

`components/markdown.tsx` (`MarkdownView`) renders bodies everywhere:
react-markdown with remark-gfm, no HTML, callouts, heading anchors from
`github-slugger` numbered over all headings like the server's sections
(including a leading title heading it hides), and page links resolved with
`resolveLink`.
