import { Hono } from "hono";
import { createUpdatesHandler } from "@meldgrove/ui/updates/server";
import { config } from "../config";
import type { AppEnv } from "../http/env";
import { requireAdmin } from "../http/middleware";
import { logger } from "../logger";

/**
 * Updates of the app, for admins in the web app (never agents or service
 * tokens): the status, a check, an installation and the channel. The shared
 * handler of @meldgrove/ui asks the Meldgrove Updater at UPDATER_URL with
 * UPDATER_TOKEN (docs/deployment.md, Automatic updates). The API's
 * middleware has already refused changes from other sites (sameOrigin).
 */
const updates = createUpdatesHandler(() => ({
  url: config().UPDATER_URL,
  token: config().UPDATER_TOKEN,
  appVersion: config().APP_VERSION ?? null,
  logger,
}));

const router = new Hono<AppEnv>();

router.get("/admin/updates", (c) => {
  requireAdmin(c);
  return updates.respond("status");
});

router.post("/admin/updates/check", (c) => {
  requireAdmin(c);
  return updates.respond("check");
});

router.post("/admin/updates/install", (c) => {
  requireAdmin(c);
  return updates.respond("install", c.req.raw);
});

router.post("/admin/updates/channel", (c) => {
  requireAdmin(c);
  return updates.respond("channel", c.req.raw);
});

export default router;
