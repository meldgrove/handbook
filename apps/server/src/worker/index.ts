import { writeFile } from "node:fs/promises";
import { config } from "../config";
import { getDb } from "../db/client";
import { logger } from "../logger";
import { monitored } from "../error-reporting";
import { reindexIfLanguagesChanged } from "../search/reindex";
import { pruneExpired } from "./prune";

export type Stop = () => Promise<void>;

/** Repeats a job every `minutes`, first after `firstDelayMs`; errors are logged, never thrown. */
function every(minutes: number, firstDelayMs: number, name: string, job: () => Promise<unknown>): Stop {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const run = () => {
    running = job()
      .catch((error: unknown) => logger.error({ err: error, task: name }, "scheduled job failed"))
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(run, minutes * 60_000);
      });
  };
  timer = setTimeout(run, firstDelayMs);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

/**
 * The worker: rebuilds the search index when SEARCH_LANGUAGES changed, and
 * removes what expired (edit locks, sign-in requests and tokens of
 * connected apps, unused uploads).
 */
export function startWorker(): Stop {
  const heartbeat = config().WORKER_HEARTBEAT_FILE;
  const beat = heartbeat
    ? setInterval(() => void writeFile(heartbeat, "").catch(() => undefined), 5_000)
    : undefined;
  if (heartbeat) void writeFile(heartbeat, "").catch(() => undefined);
  const stops: Stop[] = [
    every(24 * 60, 1_000, "search-languages", () => reindexIfLanguagesChanged(getDb())),
    every(60, 60_000, "prune", () =>
      monitored("knowledge-prune", { minutes: 60 }, () => pruneExpired(getDb())),
    ),
  ];
  logger.info("worker started");
  return async () => {
    if (beat) clearInterval(beat);
    await Promise.all(stops.map((stop) => stop()));
  };
}
