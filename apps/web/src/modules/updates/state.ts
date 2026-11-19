import {
  UPDATE_DIGEST,
  type InstallStage,
  type Update,
  type UpdaterStatus,
  type UpdatesResponse,
} from "@handbook/shared/api/updates";

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
  options: { waiting: boolean; checking: boolean; followed?: string | null },
): ButtonState {
  const status = response.updater;
  if (options.waiting || status?.installing) return "installing";
  if (!response.reachable || !status) return "unreachable";
  if (options.checking || status.checking) return "checking";
  if (failedInstall(response, options.followed)) return "failed";
  if (status.available) return "available";
  if (status.attention) return "attention";
  // Mode off still shows what is new (without installing); "off" only when nothing is.
  return status.mode === "off" ? "off" : "current";
}

/** A failed installation the button shows, and the offer that can try it again (null: none). */
export type FailedInstall = { version: string; message: string | null; offer: Update | null };

/**
 * The updater's `last` when it failed or rolled back, for a version still
 * offered or for the installation this tab followed (`followed`). The offer
 * only decides whether it can be tried again; `available.failed` is not
 * required, because the updater does not set it for every failure (e.g. a
 * server that never took the request).
 */
export function failedInstall(response: UpdatesResponse, followed?: string | null): FailedInstall | null {
  const status = response.updater;
  const last = status?.last;
  if (!status || !last || (last.result !== "failed" && last.result !== "rolled-back")) return null;
  const offer =
    [status.available, status.attention].find((update) => update?.version === last.version) ?? null;
  if (!offer && followed !== last.version) return null;
  return { version: last.version, message: last.message ?? offer?.failed ?? null, offer };
}

/**
 * What the popover offers for an update: install it, install it anyway
 * (upgrade steps; only while admins can reach it: with `channelLocked` set,
 * the image tag where the app is deployed decides and does not reach a new
 * series), nothing in mode off, or nothing when it is not offered.
 */
export function installAction(
  status: UpdaterStatus,
  update: Update,
): "install" | "anyway" | "locked" | "off" | null {
  if (status.mode === "off") return "off";
  if (status.available?.version === update.version) return "install";
  if (status.attention?.version === update.version)
    return status.channelLocked === null ? "anyway" : "locked";
  return null;
}

/** The version that runs now, as the updater or the app knows it. */
export function installedVersion(response: UpdatesResponse): string | null {
  return response.updater?.installed ?? response.app.version;
}

/** An installation this tab follows, kept in sessionStorage across reloads. */
export type PendingInstall = {
  version: string;
  /** Date.now() when the attempt started (before the request), or when the installation started. */
  startedAt: number;
  /** The updater took it (202) or a status reported it; until then, it may not have started. */
  confirmed: boolean;
  /** Why the answer to the install left it open (an unconfirmed attempt only). */
  reason: string | null;
  /** Date.now() of the last failed status request after the start (the app restarted); null: none. */
  outageAt: number | null;
};

/** An attempt of this tab, remembered before the install request. */
export function pendingInstall(version: string, now: number): PendingInstall {
  return { version, startedAt: now, confirmed: false, reason: null, outageAt: null };
}

/** An installation a status reports (automatic, another admin's): followed from when it started. */
export function adoptInstall(
  installing: { version: string; startedAt: string },
  now: number,
): PendingInstall {
  const started = Date.parse(installing.startedAt);
  return {
    version: installing.version,
    startedAt: Number.isNaN(started) ? now : Math.min(now, started),
    confirmed: true,
    reason: null,
    outageAt: null,
  };
}

/** How the app answered the install request. */
export type InstallReply =
  /** 2xx: the updater took it (202), or the app could not tell (`reachable: false`, a timeout in `error`). */
  | { kind: "answer"; response: UpdatesResponse }
  /** 4xx (409: the updater refused, with the latest status). */
  | { kind: "refused"; response: UpdatesResponse | null; error: string }
  /** A network error or a 5xx: it may have started. */
  | { kind: "failed"; error: string };

/**
 * The attempt after the install answer: confirmed, kept open (ambiguous:
 * the status decides within RECONCILE_MS), forgotten with the refusal, or
 * replaced by the installation the refusal's status reports.
 */
export function afterInstallReply(
  pending: PendingInstall,
  reply: InstallReply,
  now: number,
): { pending: PendingInstall | null; refused: string | null } {
  if (reply.kind === "refused") {
    const running = reply.response?.updater?.installing;
    if (running) return { pending: adoptInstall(running, now), refused: null };
    return { pending: null, refused: reply.error };
  }
  if (reply.kind === "failed") return { pending: { ...pending, reason: reply.error }, refused: null };
  const { response } = reply;
  if (response.reachable && response.updater && !response.error) {
    return { pending: { ...pending, confirmed: true, reason: null }, refused: null };
  }
  return { pending: { ...pending, reason: response.error ?? pending.reason }, refused: null };
}

/** How long an unconfirmed attempt waits for a status that reports it. */
export const RECONCILE_MS = 60_000;

export type InstallOutcome =
  { kind: "waiting"; confirmed: boolean } | { kind: "done" } | { kind: "failed" } | { kind: "not-started" };

/**
 * Whether the installation ended, from a status answer received at
 * `receivedAt`. Answers from before the attempt do not count, nor a `last`
 * that finished before it. In this order: a failed `last` for the version;
 * `installing` for it keeps waiting (also when the app already runs it: on
 * a server, the result comes only after every service is healthy, and it
 * may still roll back); `installed`; a platform's `accepted` once the app
 * runs the version, or, when the app cannot tell (no app version, a
 * digest), once it answered after an outage; otherwise the app running the
 * version. An unconfirmed attempt that no status reports within
 * RECONCILE_MS did not start.
 */
export function installOutcome(
  pending: PendingInstall,
  response: UpdatesResponse,
  receivedAt: number,
  now: number,
): InstallOutcome {
  const waiting = { kind: "waiting", confirmed: pending.confirmed } as const;
  const status = response.updater;
  // Not fresh, or the updater did not answer (it restarts with the app): no news.
  if (receivedAt < pending.startedAt || !status) return waiting;
  const last =
    status.last?.version === pending.version && Date.parse(status.last.finishedAt) >= pending.startedAt
      ? status.last
      : null;
  if (last?.result === "failed" || last?.result === "rolled-back") return { kind: "failed" };
  if (status.installing?.version === pending.version) return { kind: "waiting", confirmed: true };
  if (last?.result === "installed") return { kind: "done" };
  const appVersion = response.app.version;
  if (last?.result === "accepted") {
    if (appVersion !== null && !UPDATE_DIGEST.test(pending.version)) {
      return appVersion === pending.version ? { kind: "done" } : { kind: "waiting", confirmed: true };
    }
    return pending.outageAt !== null && receivedAt > pending.outageAt
      ? { kind: "done" }
      : { kind: "waiting", confirmed: true };
  }
  if (appVersion === pending.version) return { kind: "done" };
  if (!pending.confirmed && now - pending.startedAt >= RECONCILE_MS) return { kind: "not-started" };
  return waiting;
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
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Partial<PendingInstall> | null;
    if (!value || typeof value.version !== "string" || typeof value.startedAt !== "number") return null;
    return {
      version: value.version,
      startedAt: value.startedAt,
      confirmed: value.confirmed !== false,
      reason: typeof value.reason === "string" ? value.reason : null,
      outageAt: typeof value.outageAt === "number" ? value.outageAt : null,
    };
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
