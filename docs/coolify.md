# Coolify

For the person who runs Meldgrove Handbook on
[Coolify](https://coolify.io) instead of on a Linux server of its own.
Coolify uses `compose.coolify.yaml`: the services of `compose.yaml`, without
a host port, pulling the images at every deploy, and with an `updater` that
calls Coolify's deploy link. Requirements, health checks, backups, Sentry,
logs and hardening are the same as on a server: see
[Deployment](deployment.md). Every environment variable is described in
[Configuration](configuration.md).

## Setup

1. **Database:** create a PostgreSQL resource (16 or later) and copy its
   internal URL.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/handbook`, branch `stable`,
   Docker Compose location `/compose.coolify.yaml`. Under Advanced, set Auto
   deploy to "Manual deployments only", so that only releases deploy, and
   turn on "Connect To Predefined Network", so that the app reaches the
   database.
3. **Domain:** assign the domain, such as `https://handbook.example.org`,
   to `web`, port 3000.
4. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
5. **Environment variables** of the resource: `HANDBOOK_VERSION` (a series
   such as `0.1`, see [Automatic updates](#automatic-updates)), `APP_URL`
   (the domain), `DATABASE_URL` (the database's internal URL), a new
   `AUTH_SECRET` (`openssl rand -base64 32`), the `OIDC_*` values, your
   address in `ADMIN_EMAILS`, and `SEARCH_LANGUAGES` for the languages your
   pages are written in.
6. **Deploy**, open `APP_URL`, sign in, and create the first space under
   **Administration → Spaces**.
7. **Automatic updates:** set them up as [below](#automatic-updates).

Coolify's proxy must pass `/mcp`, `/oauth/*` and `/.well-known/*` to the app
unchanged, as on a server ([What runs](deployment.md#what-runs)).

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then change `HANDBOOK_VERSION` in the resource's
   environment variables to the new series and redeploy. Coolify reads
   `compose.coolify.yaml` from `stable`, which is at the newest release.

The `migrate` service applies database migrations before `web` and `worker`
start.

## Backups

For [Meldgrove Backups](deployment.md#backups), set `BACKUP_URL` and
`BACKUP_TOKEN` (from the app's source in Backups) in the resource's
environment variables and redeploy. Each deploy pulls the backup agent's
image.

## Automatic updates

On Coolify, the image tag in `HANDBOOK_VERSION` decides what installs: a
series such as `0.1` gets its releases, `latest` every release (also those
with upgrade steps), `preview` every preview (the unstable channel). Admins
see the update button as on a server, but cannot switch the channel in the
app. `UPDATE_COOLDOWN`, `UPDATE_WINDOW` and `TZ` work as on a server
([Automatic updates](deployment.md#automatic-updates)).

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In the Handbook resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

The `updater` log then names the tag it watches. Set up backups first:
migrations run without anyone watching.

## Moving an existing resource

Resources set up before `compose.coolify.yaml` existed read
`/compose.yaml`. That file is made for a server now: it has no deploy link
and does not pull the images again, so automatic updates stop with it. Once
the release that brings `compose.coolify.yaml` is out (its release notes
name this step):

1. In the resource's configuration, set Docker Compose Location to
   `/compose.coolify.yaml` and save.
2. Keep the environment variables. Change `HANDBOOK_VERSION` when the
   release starts a new series.
3. Redeploy. The services and volumes keep their names, so the data stays.
