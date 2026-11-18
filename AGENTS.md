# AGENTS.md

Meldgrove Handbook is a self-hosted knowledge base: spaces of Markdown pages
with YAML frontmatter, edited by staff in the browser and by AI agents
through MCP. Agents and readers propose changes as change sets that editors
review and merge. User documentation is in `docs/`; contributor setup is in
`CONTRIBUTING.md`; how it works inside is in `docs/architecture.md`.

## Stack

npm workspaces, Node.js 26, strict TypeScript.

- `apps/server`: Hono (API under `/api/v1`, MCP under `/mcp`, OAuth under
  `/.well-known` and `/oauth`), Better Auth (OIDC sign-in under `/api/auth`),
  Drizzle ORM on PostgreSQL, remark (Markdown analysis), the MCP TypeScript
  SDK, pino logs, Sentry, Vitest.
- `apps/web`: Vite + React 19, TanStack Router and Query, shadcn/ui with
  Tailwind CSS 4, CodeMirror 6 (the editor), react-markdown. US English.
- `packages/shared` (`@handbook/shared/*`): zod schemas of the API
  (`api/*.ts`), the page file model (`page.ts`), paths and links
  (`paths.ts`), merging and edits (`merge.ts`), roles and abilities
  (`roles.ts`), limits.

One Docker image runs every process: `APP_ROLE` = `all | web | worker | migrate`.

## Layout

```
apps/server/src/
  main.ts          entry; APP_ROLE selects the processes
  config.ts        every environment variable (zod); read only via config()
  db/schema/       Drizzle schema (auth.ts, app.ts)
  auth/            Better Auth, sign-in access check, credentials (tokens), principals
  pages/           the page core (core.ts: the one write path), locks, views, Markdown analysis
  changes/         change sets: items, checks, merge, revert
  spaces/          spaces, members, abilities (access.ts)
  search/          search queries and the index
  exports/         export of spaces (zip of pages and their uploads)
  files/           uploaded files on disk
  oauth/           OAuth 2.1 server for connected apps (MCP clients)
  mcp/             MCP server and tools (call the REST API in-process)
  http/            app factory, middleware, errors, raw routes (/files, /s/*.md, /llms.txt)
  modules/         one file per API area: routes
  worker/          scheduled jobs
apps/web/src/      web app; modules/<area> holds each area's pages
packages/shared/src/  contracts, page model, paths, merge, roles
```

## Rules

- **Contracts first.** Change a request or response in
  `packages/shared/src/api/` and use it on both sides; routes validate input
  with it (`jsonBody`, `queryOf`).
- **Access:** every route starts with `requirePrincipal`, `requireUser`,
  `requireWebUser` or `requireAdmin`, and space actions check
  `spaceContext` + `requireAbility`. Abilities come only from
  `spaceAbilities` in `packages/shared/src/roles.ts`. Agents (personal
  tokens, connected apps) never edit live, never merge and never administer;
  service tokens only read.
- **Pages change only through `apps/server/src/pages/core.ts`** inside a
  transaction (`lockPage` first). It validates the file, merges with changes
  saved meanwhile, stores the revision and rebuilds sections, links and
  search data. Never update `pages` or `page_revisions` elsewhere.
- **Page files:** parse and write them only with
  `packages/shared/src/page.ts`; links resolve only with `resolveLink`.
- **Credentials** are stored as SHA-256 hashes; secrets are shown once and
  never logged. Never log authorization codes, PKCE verifiers or tokens.
- **Errors:** throw `AppError` helpers (`http/errors.ts`) with short, plain
  messages.
- **Logging:** `logger` with ids and codes; never page texts, titles, email
  addresses, tokens or other personal data. No `console.*`, no `any`.
- **Sentry** gets no personal data: `redactErrorReport` and `redactLog`
  decide what reports and logs keep; no session replays.
- **SQL in select lists:** Drizzle writes column names there without the
  table name; inside a correlated subquery write `"table"."column"`
  yourself.

## Database

Change the schema in `apps/server/src/db/schema/`, then run
`npm run db:generate` and commit the migration. CI fails when they differ.

## Tests

- Unit tests next to the code (`*.test.ts`); integration tests
  (`*.int.test.ts`) use the PostgreSQL of `compose.dev.yaml` and
  `src/test/helpers.ts` (`resetDatabase`, `createUser`, `createSpace`,
  `createPage`, `createToken`, `request`).
- API tests act as web users with
  `vi.mock("../auth/resolve", () => import("../test/resolve-mock"))` and the
  `userId` option; bearer tokens (`token` option) work as in production.
- End-to-end tests (`e2e/`) run a real browser against the built app and the
  development Keycloak.

## Commands

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL (55450), Keycloak (8104)
cp .env.example .env.local
npm ci
npm run dev                                # web app http://localhost:5173, server :3000

npm run lint && npm run format:check && npm run typecheck && npm test
npm run test:integration
npm run build && npm run test:e2e
```

Releases: Actions → Release → Run workflow (shared Meldgrove workflow; see
`CONTRIBUTING.md`). No file holds the version.

## Content

UI text and messages are in US English; short and plain. Never commit
secrets, real personal data or data from a real organization: use
`example.org` addresses and invented content.
