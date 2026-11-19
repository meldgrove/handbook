# Deployment

For the person who runs Meldgrove Handbook on a Linux server, such as a VPS
with Debian or Ubuntu: requirements, [setup](#setup), upgrades, automatic
updates, backups, Sentry and troubleshooting. Every environment variable is
described in [Configuration](configuration.md). To run it on Coolify instead,
see [Coolify](coolify.md).

## Requirements

- **A server with Debian 12 or later** (or a similar system with systemd and
  apt, such as Ubuntu 24.04), with Docker Engine and its Compose plugin, and a
  domain name that points at it.
- **PostgreSQL 16 or later**, with the `pg_trgm` extension available (it is
  part of the standard PostgreSQL packages and images; the first migration
  creates it): a database of your own, or the one `compose.postgres.yaml`
  adds.
- **Caddy** (or another reverse proxy on the server) that terminates HTTPS.
- **An OpenID Connect provider** for sign-in (Keycloak, Microsoft Entra ID,
  Google, Authentik, …), see [Identity and access](identity-and-access.md).
- **Disk space for uploaded files** (a volume).

## What runs

Each [release](https://github.com/meldgrove/handbook/releases) publishes the
image `ghcr.io/meldgrove/handbook` for linux/amd64 and linux/arm64, tagged
with its version (`0.1.0`), its series (`0.1`; from 1.0.0 the major version,
`1`) and `latest`. A release that needs manual steps starts a new series, so
the releases within a series install without anyone acting. Every change on
`main` whose checks pass is published as a preview, tagged `0.1.1-preview.3`
(three changes after 0.1.0) and `preview`.

| File                    | Contains                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `worker`, `migrate`) picks the role.         |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`), the `worker` and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.       |
| `compose.coolify.yaml`  | The same as `compose.yaml`, for [Coolify](coolify.md).                             |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`HANDBOOK_PORT` changes the host port. With several apps on one server, give
each its own port and its own site in the Caddyfile. Uploaded files are stored in the
volume `files` (`/data/files` in the container), shared by `web` and
`worker`. The branch `stable` is at the newest release; `main` has changes
that are not released yet.

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

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/handbook.git /srv/handbook
   cd /srv/handbook
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `HANDBOOK_VERSION` (a
   series such as `0.1`), `APP_URL`, `DATABASE_URL`, a new `AUTH_SECRET`
   (`openssl rand -base64 32`), the `OIDC_*` values, your address in
   `ADMIN_EMAILS`, and `SEARCH_LANGUAGES` for the languages your pages are
   written in. Remove `NODE_ENV=development`, `RUN_MIGRATIONS` and
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. With an `https` `APP_URL`, the app
   does not start with the example `AUTH_SECRET` or with
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. Without a database of your own, add
   `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a `POSTGRES_PASSWORD`
   (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://handbook:<POSTGRES_PASSWORD>@postgres:5432/handbook`.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   handbook.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself, and it
   passes the event streams of `/mcp` through without buffering. With
   `HANDBOOK_PORT` set, use that port instead of 3000.

7. Open `APP_URL`, sign in, and create the first space under
   **Administration → Spaces**.
8. **Automatic updates:** [set them up](#setup-on-the-server).

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age. It stops while a job runs far longer than
  it should (the hourly cleanup 30 minutes, rebuilding the search index 4
  hours), so the check fails.
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
2. Take the steps, then move to the new series: in `/srv/handbook`, run
   `git pull` (the newest release's `compose.yaml`), change
   `HANDBOOK_VERSION` in `.env`, and run `docker compose up -d --pull always`.
   With automatic updates, run only the `git pull` and let the update
   button install it (**Install anyway…**).

The `migrate` service applies database migrations before `web` and `worker`
start.

## Automatic updates

The `updater` service ([meldgrove/updater](https://github.com/meldgrove/updater))
keeps Handbook current, in one of two channels:

- **Stable** (default): releases. A release in the running series installs
  automatically once it has been out for three days (`UPDATE_COOLDOWN`: `0`
  installs within the hour, `7d` waits a week). A release with upgrade steps
  starts a new series: the app shows it, but it never installs on its own.
- **Preview**: every change on `main` as soon as its checks pass, before it
  is released, and every release. Previews install within the hour. New
  features first, and now and then a new bug; previews have no release notes.

With `UPDATE_WINDOW` (such as `02:00-05:00`, in the time zone `TZ`),
automatic installs happen only then. Switching from Preview back to Stable
installs nothing: the preview runs until a release is newer.

**The update button:** admins see an update icon in the header. It checks on
click, shows an available update with its changes, installs it on request
(**Install now**), shows the progress, reloads the page when the new version
runs, and says why an installation failed. With automatic updates off on
the server, it still shows new releases, but nothing installs from the app.
Admins choose the channel under **Administration → Updates**. The app reaches the updater at `UPDATER_URL`
(`http://updater:8080` in `compose.yaml`); never publish the updater's port.

Set up [backups](#backups) first: migrations run without anyone watching.

### Setup on the server

As root in `/srv/handbook`:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the version in `HANDBOOK_VERSION`, which the
updater takes as installed. The second writes the setup script from the
updater's image; read it before you run it. The script installs a systemd
unit that waits for the updater's requests. For each installation, it writes
the exact version into `HANDBOOK_VERSION` in `.env`, pulls the image, runs
`docker compose up -d --wait` (migrations first), and goes back to the
version before when the app does not become healthy. It installs images,
not files: when a release changes `compose.yaml`, its upgrade steps say so.
`journalctl -u meldgrove-updater-handbook.service` shows each installation;
`sh updater-setup.sh remove` switches it off.

**Installations with updater 0.1** followed the tag in `HANDBOOK_VERSION`
and have no channels or update button. To get them, in `/srv/handbook`:
take the new `compose.yaml`, set `HANDBOOK_VERSION` in `.env` to the release
that brings the update button (or a newer one), and start it, so that the app
runs the new version too, not only the `updater` service. Then run the host
setup again:

```sh
git pull
# in .env: HANDBOOK_VERSION=<the release that brings the update button, or newer>
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh && sudo sh updater-setup.sh
```

Until the host setup runs again, the updater follows the tag as before, and
the app says that the channel needs it.

## Backups

Back up together:

- the PostgreSQL database (`pg_dump`, or the `postgres` volume): pages,
  every revision, change sets, people, tokens (as hashes);
- the `files` volume (uploaded images and attachments; pages refer to them).

Test a restore once, and again after larger changes to the setup: restore
the database and the `files` volume on another machine (or into a new
Compose project), start the app there, and open a few pages with images.

Each space can also be exported as a zip of its Markdown files and the
uploads its pages use (space menu → Export), for a copy outside the app.
It is not a backup of the app: history, change sets and people are not in it.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `handbook@<version>`, so
reports link to the code: release builds upload their source maps to
Sentry. The web app's source maps are not in the image, so browsers cannot
download them.

- **Errors:** crashes, failed requests and errors the server logs, from the
  server and from browsers.
- **Performance:** set `SENTRY_TRACES_SAMPLE_RATE` (e.g. `0.2`) to trace
  that share of requests and page loads.
- **Logs:** warnings and errors of the server.
- **Cron monitor:** the worker's cleanup job checks in as `handbook-prune`.

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
