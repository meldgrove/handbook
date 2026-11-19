import type { InstallStage, Update, UpdatesResponse } from "@handbook/shared/api/updates";

/** What the update button shows. */
export type ButtonState =
  "checking" | "current" | "available" | "attention" | "installing" | "failed" | "off" | "unreachable";

/** States whose button opens a popover; the others check (or ask again) on click. */
export const POPOVER_STATES: ReadonlySet<ButtonState> = new Set([
  "available",
  "attention",
  "installing",
  "failed",
  "off",
]);

export function buttonState(
  response: UpdatesResponse,
  options: { waiting: boolean; checking: boolean },
): ButtonState {
  const status = response.updater;
  if (options.waiting || status?.installing) return "installing";
  if (!response.reachable || !status) return "unreachable";
  if (options.checking || status.checking) return "checking";
  if (status.mode === "off") return "off";
  if (failedUpdate(response)) return "failed";
  if (status.available) return "available";
  if (status.attention) return "attention";
  return "current";
}

/** The update whose last installation failed, while it is still offered. */
export function failedUpdate(response: UpdatesResponse): Update | null {
  const status = response.updater;
  const last = status?.last;
  if (!status || !last || (last.result !== "failed" && last.result !== "rolled-back")) return null;
  if (status.available?.failed) return status.available;
  if (status.attention?.failed && status.attention.version === last.version) return status.attention;
  return null;
}

/** The version that runs now, as the updater or the app knows it. */
export function installedVersion(response: UpdatesResponse): string | null {
  return response.updater?.installed ?? response.app.version;
}

/** An installation an admin started in this tab, kept in sessionStorage across reloads. */
export type PendingInstall = {
  version: string;
  /** Date.now() when it started. */
  startedAt: number;
  /** The app's version before. */
  appVersion: string | null;
  /** `updater.last.finishedAt` before: a result with another time is this installation's. */
  lastFinishedAt: string | null;
  /** The app did not answer at some point (it restarted). */
  outage: boolean;
};

export function pendingInstall(
  version: string,
  before: UpdatesResponse | undefined,
  now: number,
): PendingInstall {
  return {
    version,
    startedAt: now,
    appVersion: before?.app.version ?? null,
    lastFinishedAt: before?.updater?.last?.finishedAt ?? null,
    outage: false,
  };
}

export type InstallOutcome = "done" | "failed" | "waiting";

/**
 * Whether an installation ended: the app runs the version, or the updater
 * names its result. A platform's `accepted` counts once the app changed or
 * came back after an outage.
 */
export function installOutcome(pending: PendingInstall, response: UpdatesResponse): InstallOutcome {
  if (response.app.version === pending.version) return "done";
  const last = response.updater?.last;
  if (!last || last.version !== pending.version || last.finishedAt === pending.lastFinishedAt)
    return "waiting";
  if (last.result === "failed" || last.result === "rolled-back") return "failed";
  if (last.result === "installed") return "done";
  return response.app.version !== pending.appVersion || pending.outage ? "done" : "waiting";
}

/** After this long without a result, the button says to look at the server. */
export const INSTALL_PATIENCE_MS = 15 * 60_000;

export const STAGE_KEYS: Record<
  InstallStage,
  "stageRequested" | "stagePulling" | "stageStarting" | "stageRollingBack" | "stageDeploying"
> = {
  requested: "stageRequested",
  pulling: "stagePulling",
  starting: "stageStarting",
  "rolling-back": "stageRollingBack",
  deploying: "stageDeploying",
};

/** "Installs automatically on …", "… at the next check", or nothing. */
export function installsAt(
  update: Update,
  now: number,
): { kind: "on"; date: string } | { kind: "next" } | null {
  if (!update.installsAt) return null;
  return new Date(update.installsAt).getTime() > now
    ? { kind: "on", date: update.installsAt }
    : { kind: "next" };
}

/** The first notes and how many changes are left. */
export function shownNotes(update: Update, max = 8): { notes: string[]; more: number } {
  const notes = update.notes.slice(0, max);
  return { notes, more: Math.max(0, Math.max(update.changes, update.notes.length) - notes.length) };
}

/** A cooldown such as `3d`, `12h`, `30m` or seconds, as a count and unit; null when unknown. */
export function cooldownParts(
  cooldown: string,
): { count: number; unit: "days" | "hours" | "minutes" | "seconds" } | null {
  const match = /^(\d+)([dhms]?)$/.exec(cooldown.trim());
  if (!match) return null;
  const seconds = Number(match[1]) * { d: 86_400, h: 3_600, m: 60, s: 1, "": 1 }[match[2] as "d"];
  if (seconds === 0) return null;
  if (seconds % 86_400 === 0) return { count: seconds / 86_400, unit: "days" };
  if (seconds % 3_600 === 0) return { count: seconds / 3_600, unit: "hours" };
  if (seconds % 60 === 0) return { count: seconds / 60, unit: "minutes" };
  return { count: seconds, unit: "seconds" };
}

/** A link from the updater, only when it is http(s). */
export function safeUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

const STORAGE_KEY = "handbook.update-install";

export function loadPending(): PendingInstall | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as PendingInstall | null;
    return value && typeof value.version === "string" && typeof value.startedAt === "number" ? value : null;
  } catch {
    return null;
  }
}

export function savePending(pending: PendingInstall | null) {
  try {
    if (pending) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without storage, a reload stops waiting; the button still shows the updater's state.
  }
}
