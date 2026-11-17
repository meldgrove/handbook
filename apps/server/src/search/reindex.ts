import { config } from "../config";
import type { Db } from "../db/client";
import { spaces } from "../db/schema";
import { getSetting, putSetting } from "../core/settings";
import { logger } from "../logger";
import { reindexAllPages } from "../pages/core";

/**
 * Rebuilds the search index when SEARCH_LANGUAGES changed since it was
 * built. Runs at the start of the worker; cheap when nothing changed.
 */
export async function reindexIfLanguagesChanged(db: Db) {
  const wanted = config().searchConfigs.join(",");
  const stored = await getSetting(db, "search");
  if (stored?.languages === wanted) return;
  for (const space of await db.select().from(spaces)) {
    await db.transaction((tx) => reindexAllPages(tx, space));
  }
  await putSetting(db, "search", { languages: wanted });
  if (stored) logger.info({ languages: wanted }, "search index rebuilt for new languages");
}
