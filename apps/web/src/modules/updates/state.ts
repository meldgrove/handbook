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
  // A newer offer replaces a failure that cannot be tried again; the failure stays as a line in it.
  const failure = failedInstall(response, options.followed);
  if (failure && (failure.offer || !(status.available || status.attention))) return "failed";
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
 * The updater's `last` when it failed or rolled back for a version that is
 * no longer offered while a newer one is: a line in that offer ("0.2.1
 * failed: …").
 */
export function replacedFailure(
  response: UpdatesResponse,
): { version: string; message: string | null } | null {
  const status = response.updater;
  const last = status?.last;
  if (!status || !last || (last.result !== "failed" && last.result !== "rolled-back")) return null;
  const offers = [status.available, status.attention].filter((update) => update !== null);
  if (offers.length === 0 || offers.some((update) => update.version === last.version)) return null;
  return { version: last.version, message: last.message };
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

/** A result of an installation, as the updater reports it in `last`. */
export type LastResult = NonNullable<UpdaterStatus["last"]>;

/** An installation this tab follows, kept in sessionStorage across reloads. */
export type PendingInstall = {
  version: string;
  /** Date.now() when the attempt started (before the request), or when the installation started. */
  startedAt: number;
  /** The updater took it (202) or a status reported it; until then, it may not have started. */
  confirmed: boolean;
  /** Why the answer to the install left it open (an unconfirmed attempt only). */
  reason: string | null;
  /** Date.now() of the last outage after the start (no answer, a 5xx, `reachable: false`); null: none. */
  outageAt: number | null;
  /** The `last` of the newest status before the attempt (the "earlier result"): never this installation's. */
  earlier: LastResult | null;
  /** `installing.startedAt` once a status reported the installation: with the version, its identity. */
  installStartedAt: string | null;
  /** The newest status request after the start brought a status (true), or an error or none (false). */
  answered: boolean;
  /** The newest error of a status request after the start. */
  lastError: string | null;
};

/** An attempt of this tab, remembered before the install request with the newest status's `last`. */
export function pendingInstall(
  version: string,
  now: number,
  earlier: LastResult | null = null,
): PendingInstall {
  return {
    version,
    startedAt: now,
    confirmed: false,
    reason: null,
    outageAt: null,
    earlier,
    installStartedAt: null,
    answered: false,
    lastError: null,
  };
}

/** An installation a status reports (automatic, another admin's): followed from when it started. */
export function adoptInstall(
  installing: { version: string; startedAt: string },
  earlier: LastResult | null,
  now: number,
): PendingInstall {
  const started = Date.parse(installing.startedAt);
  return {
    ...pendingInstall(installing.version, Number.isNaN(started) ? now : Math.min(now, started), earlier),
    confirmed: true,
    installStartedAt: installing.startedAt,
  };
}

/** How the app answered the install request. */
export type InstallReply =
  /** 202: the updater took it (also when the body cannot be read). */
  | { kind: "accepted"; response: UpdatesResponse | null }
  /** Another 2xx (`reachable: false`, a timeout in `error`, an unreadable body): it may have started. */
  | { kind: "answer"; response: UpdatesResponse | null }
  /** 4xx (409: the updater refused, with the latest status; 401/403 or a sign-in page). */
  | { kind: "refused"; response: UpdatesResponse | null; error: string }
  /** A network error or a 5xx: it may have started. */
  | { kind: "failed"; error: string };

/**
 * The attempt after the install answer: confirmed (202), kept open
 * (ambiguous: a status decides within RECONCILE_MS), forgotten with the
 * refusal, or replaced by the installation the refusal's status reports.
 */
export function afterInstallReply(
  pending: PendingInstall,
  reply: InstallReply,
  now: number,
): { pending: PendingInstall | null; refused: string | null } {
  if (reply.kind === "refused") {
    const running = reply.response?.updater?.installing;
    if (running)
      return { pending: adoptInstall(running, reply.response?.updater?.last ?? null, now), refused: null };
    return { pending: null, refused: reply.error };
  }
  if (reply.kind === "accepted")
    return { pending: { ...pending, confirmed: true, reason: null }, refused: null };
  const reason = reply.kind === "failed" ? reply.error : (reply.response?.error ?? UNREADABLE_ANSWER);
  return { pending: { ...pending, reason }, refused: null };
}

/** Why an answer without a status left an attempt open. */
export const UNREADABLE_ANSWER = "The app sent an answer that this page cannot read.";

/** How long an unconfirmed attempt waits for a status that reports it. */
export const RECONCILE_MS = 60_000;

/** The updater writes times in whole seconds (UTC). */
const wholeSecond = (time: number) => Math.floor(time / 1000) * 1000;

/** What a status request after the start brought, at `at` (Date.now()): an answer or an error. */
export type StatusRequest = { at: number } & ({ response: UpdatesResponse } | { error: string });

/**
 * The attempt after a status request: an outage (an error, `reachable:
 * false`), the newest error, whether a status answered, and the identity
 * of the installation once a status reports it. Requests from before the
 * start change nothing.
 */
export function observe(pending: PendingInstall, request: StatusRequest): PendingInstall {
  if (request.at < pending.startedAt) return pending;
  if ("error" in request) {
    return { ...pending, outageAt: request.at, answered: false, lastError: request.error };
  }
  const { response } = request;
  const status = response.updater;
  if (!status) {
    return {
      ...pending,
      outageAt: response.reachable ? pending.outageAt : request.at,
      answered: false,
      lastError: response.error ?? pending.lastError,
    };
  }
  const running = status.installing?.version === pending.version ? status.installing : null;
  return { ...pending, answered: true, installStartedAt: running?.startedAt ?? pending.installStartedAt };
}

/**
 * The status's `last` when it is this installation's result: for the
 * version, not the earlier result, and finished at or after the start of
 * the installation (`installing.startedAt` when seen, otherwise the
 * attempt's start cut to whole seconds, as the updater writes them).
 */
export function freshLast(pending: PendingInstall, status: UpdaterStatus): LastResult | null {
  const last = status.last;
  if (!last || last.version !== pending.version) return null;
  const { earlier } = pending;
  if (
    earlier &&
    earlier.version === last.version &&
    earlier.result === last.result &&
    earlier.finishedAt === last.finishedAt
  ) {
    return null;
  }
  const installStarted = pending.installStartedAt === null ? NaN : Date.parse(pending.installStartedAt);
  const since = Number.isNaN(installStarted) ? wholeSecond(pending.startedAt) : installStarted;
  return Date.parse(last.finishedAt) >= since ? last : null;
}

export type InstallOutcome = { kind: "waiting"; confirmed: boolean } | { kind: "done" } | { kind: "failed" };

/**
 * Whether the installation ended, from a status answer received at
 * `receivedAt`. Answers from before the attempt do not count, nor a `last`
 * that is not fresh (freshLast). In this order: a failed `last` for the
 * version; `installing` for it keeps waiting (also when the app already runs
 * it: on a server, the result comes only after every service is healthy,
 * and it may still roll back); `installed`; a platform's `accepted` once the
 * app runs the version, or, when the app cannot tell (no app version, a
 * digest), once a status answered after an outage; otherwise the app
 * running the version. An unconfirmed attempt ends at its deadline
 * (unconfirmedEnd), not here.
 */
export function installOutcome(
  pending: PendingInstall,
  response: UpdatesResponse,
  receivedAt: number,
): InstallOutcome {
  const waiting = { kind: "waiting", confirmed: pending.confirmed } as const;
  const status = response.updater;
  // Not fresh, or the updater did not answer (it restarts with the app): no news.
  if (receivedAt < pending.startedAt || !status) return waiting;
  const last = freshLast(pending, status);
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
  return waiting;
}

/**
 * What the button says when an unconfirmed attempt reaches its deadline:
 * it did not start (with the reason) when the newest status answered
 * without it; otherwise it could not be confirmed (with the last error).
 */
export function unconfirmedEnd(pending: PendingInstall): {
  message: "notStarted" | "notConfirmed";
  detail: string | null;
} {
  return pending.answered
    ? { message: "notStarted", detail: pending.reason }
    : { message: "notConfirmed", detail: pending.lastError ?? pending.reason };
}

/** An installation an admin stopped waiting for: by its identity, or the version from the attempt's start. */
export type IgnoredInstall = { version: string; startedAt: string | null; since: number };

export function ignoreInstall(pending: PendingInstall): IgnoredInstall {
  return {
    version: pending.version,
    startedAt: pending.installStartedAt,
    since: wholeSecond(pending.startedAt),
  };
}

export function isIgnored(
  ignored: IgnoredInstall | null,
  installing: { version: string; startedAt: string },
): boolean {
  if (!ignored || ignored.version !== installing.version) return false;
  if (ignored.startedAt !== null) return installing.startedAt === ignored.startedAt;
  return Date.parse(installing.startedAt) >= ignored.since;
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
    const earlier = value.earlier;
    return {
      version: value.version,
      startedAt: value.startedAt,
      confirmed: value.confirmed !== false,
      reason: typeof value.reason === "string" ? value.reason : null,
      outageAt: typeof value.outageAt === "number" ? value.outageAt : null,
      earlier:
        earlier && typeof earlier.version === "string" && typeof earlier.finishedAt === "string"
          ? earlier
          : null,
      installStartedAt: typeof value.installStartedAt === "string" ? value.installStartedAt : null,
      answered: value.answered === true,
      lastError: typeof value.lastError === "string" ? value.lastError : null,
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
