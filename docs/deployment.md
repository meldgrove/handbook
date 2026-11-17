# Deployment

For the person who runs Meldgrove Knowledge on a server: requirements, a
setup with Docker Compose, upgrades, backups, Sentry and troubleshooting.
Every environment variable is described in [Configuration](configuration.md).

## Requirements

- **PostgreSQL 16 or later**, with the `pg_trgm` extension available (it is
  part of the standard PostgreSQL packages and images; the first migration
  creates it).
- **Docker with Docker Compose.** Without Docker you need Node.js 26.
- **A reverse proxy that terminates HTTPS.**
- **An OpenID Connect provider** for sign-in (Keycloak, Microsoft Entra ID,
  Google, Authentik, …), see [Identity and access](identity-and-access.md).
- **Disk space for uploaded files** (a volume).

## Setup with Docker Compose

Each [release](https://github.com/meldgrove/knowledge/releases) publishes the
image `ghcr.io/meldgrove/knowledge` for linux/amd64 and linux/arm64, tagged
with its version (`0.1.0`), its series (`0.1`; from 1.0.0 the major version,
`1`) and `latest`. A release that needs manual steps starts a new series, so
the releases within a series install without anyone acting.

| File                    | Contains                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `worker`, `migrate`) picks the role.         |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`), the `worker` and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.       |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`KNOWLEDGE_PORT` changes the host port. Uploaded files are stored in the
volume `files` (`/data/files` in the container), shared by `web` and
`worker`.

1. **Get the files:** clone the repository and check out the release, e.g.
   `git checkout v0.1.0`. Platforms that read `compose.yaml` from the
   repository follow the branch `stable`, which is at the newest release.
2. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
3. **Create `.env`** next to `compose.yaml` from `.env.example` and set
   production values: `KNOWLEDGE_VERSION`, `APP_URL`, `DATABASE_URL`, a new
   `AUTH_SECRET` (`openssl rand -base64 32`), the `OIDC_*` values, your
   address in `ADMIN_EMAILS`, and `SEARCH_LANGUAGES` for the languages your
   pages are written in. Remove `NODE_ENV=development`, `RUN_MIGRATIONS` and
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. With an `https` `APP_URL`, the app
   does not start with the example `AUTH_SECRET` or with
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`.
4. **Start:** `docker compose up -d` (with `-f compose.yaml -f
compose.postgres.yaml` and `POSTGRES_PASSWORD` for the bundled database).
5. **Point the reverse proxy** at `127.0.0.1:3000`, open `APP_URL`, sign in,
   and create the first space under **Administration → Spaces**.

The reverse proxy must pass `/mcp`, `/oauth/*` and `/.well-known/*` to the
app unchanged (agents connect there), and must not buffer or cache them:
`/mcp` streams its answers as events (nginx: `proxy_buffering off;` for
`/mcp`). The app compresses its responses itself (scripts and styles with
brotli or gzip; JSON, HTML and Markdown with gzip; never `/mcp` or
`/files`), so the proxy needs no compression of its own. A proxy that
compresses anyway must leave `/mcp` alone.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process. Mount a volume at `/data/files`.

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age. It stops while a job runs far longer than
  it should (the hourly cleanup 30 minutes, rebuilding the search index 4
  hours), so the check fails and the platform can restart the worker.
- Database connections give up after 10 seconds of waiting for a
  connection, end statements after `DATABASE_STATEMENT_TIMEOUT_SECONDS`
  and transactions left idle for a minute, and probe idle connections for
  lost ones.

Docker Compose marks a container whose check fails as unhealthy, but does
not restart it. Set up an uptime check from outside the server (your
monitoring or an uptime service) on `<APP_URL>/-/readyz`, so that someone
hears when the app is down.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Change `KNOWLEDGE_VERSION` (or let the updater do it, below) and run
   `docker compose up -d`. The `migrate` service applies database migrations
   before `web` and `worker` start.

### Automatic updates

The optional `updater` service redeploys when the tag in `KNOWLEDGE_VERSION`
points to a new image. It needs the platform's deploy link in
`UPDATE_DEPLOY_HOOK_URL` (and `UPDATE_DEPLOY_HOOK_TOKEN` when the link needs
a bearer token); without it, it does nothing. Use a series tag such as `0.1`
to get every release that installs without steps. `UPDATE_COOLDOWN` (default
`3d`) lets a release settle before it installs; `UPDATE_WINDOW` (e.g.
`02:00-05:00`, time zone `TZ`) limits when. See
[meldgrove/updater](https://github.com/meldgrove/updater).

## Backups

Back up together:

- the PostgreSQL database (`pg_dump`, or the `postgres` volume): pages,
  every revision, change sets, people, tokens (as hashes);
- the `files` volume (uploaded images and attachments; pages refer to them).

Test a restore once, and again after larger changes to the setup: restore
the database and the `files` volume on another machine (or into a new
Compose project), start the app there, and open a few pages with images.

Each space can also be exported as a zip of Markdown files (space menu →
Export), for a copy outside the app; uploaded files are not in it.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `knowledge@<version>`, so
reports link to the code: release builds upload their source maps to
Sentry. The web app's source maps are not in the image, so browsers cannot
download them.

- **Errors:** crashes, failed requests and errors the server logs, from the
  server and from browsers.
- **Performance:** set `SENTRY_TRACES_SAMPLE_RATE` (e.g. `0.2`) to trace
  that share of requests and page loads.
- **Logs:** warnings and errors of the server.
- **Cron monitor:** the worker's cleanup job checks in as `knowledge-prune`.

Reports never contain page texts, titles, names, email addresses, tokens,
request data or variables; error messages are left out because database
errors can quote values. There are no session replays.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
web`). Logs carry identifiers (page, change set, request), never page texts
or email addresses. Sign-ins that were refused log the reason (`sign-in
refused: email domain not allowed`, `… not in ACCESS_GROUPS`, `… blocked`,
`… email address not verified by the provider`).

## Hardening

- Serve the app over HTTPS only.
- Use your organization's own identity provider, where people cannot choose
  their email address themselves. With a public provider (e.g. Google),
  set `ALLOWED_EMAIL_DOMAINS` or `ACCESS_GROUPS`; without either, the
  server logs a warning at start.
- Keep `OIDC_REQUIRE_EMAIL_VERIFIED` on unless your provider does not send
  `email_verified` ([Identity and access](identity-and-access.md#verified-email-addresses)).
- When someone leaves, block them in the app for immediate effect
  ([Identity and access](identity-and-access.md#when-someone-leaves)).
- Keep `ADMIN_EMAILS` to one or two people.
- Agents only propose changes; editors decide. Read a change set's diff
  before merging it, also when an agent made it: page content can contain
  instructions meant to mislead agents.
- Pages are Markdown without HTML; uploads other than PNG, JPEG, GIF and
  WebP are always downloaded, never shown in the browser.
