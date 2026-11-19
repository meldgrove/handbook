import { describe, expect, it } from "vitest";
import type { Update, UpdaterStatus, UpdatesResponse } from "@handbook/shared/api/updates";
import {
  adoptInstall,
  afterInstallReply,
  buttonState,
  cooldownParts,
  failedInstall,
  freshLast,
  ignoreInstall,
  INSTALL_PATIENCE_MS,
  installAction,
  installOutcome,
  installsAt,
  isIgnored,
  observe,
  pendingInstall,
  replacedFailure,
  safeUrl,
  shownNotes,
  unconfirmedEnd,
  waitedTooLong,
  type PendingInstall,
} from "./state";

const NOW = Date.parse("2026-11-19T09:00:00.000Z");

function update(overrides: Partial<Update> = {}): Update {
  return {
    version: "0.2.1",
    preview: false,
    publishedAt: "2026-11-17T10:00:00.000Z",
    url: "https://github.com/meldgrove/handbook/releases/tag/v0.2.1",
    notes: ["Show who changed a page last"],
    changes: 1,
    installsAt: null,
    failed: null,
    ...overrides,
  };
}

function response(status: Partial<UpdaterStatus> | null, app: string | null = "0.2.0"): UpdatesResponse {
  return {
    app: { version: app },
    reachable: status !== null,
    updater:
      status === null
        ? null
        : {
            updater: "0.2.0",
            mode: "host",
            channel: "stable",
            channelLocked: null,
            installed: "0.2.0",
            available: null,
            attention: null,
            installing: null,
            last: null,
            checking: false,
            checkedAt: "2026-11-19T08:00:00.000Z",
            error: null,
            automatic: true,
            cooldown: "3d",
            window: null,
            timezone: "UTC",
            ...status,
          },
    error: null,
  };
}

const idle = { waiting: false, checking: false };

describe("buttonState", () => {
  it("derives every state of the button from the status", () => {
    expect(buttonState(response({}), idle)).toBe("current");
    expect(buttonState(response({}), { waiting: false, checking: true })).toBe("checking");
    expect(buttonState(response({ checking: true }), idle)).toBe("checking");
    expect(buttonState(response({ available: update() }), idle)).toBe("available");
    expect(buttonState(response({ attention: update({ version: "0.3.0" }) }), idle)).toBe("attention");
    expect(
      buttonState(response({ available: update(), attention: update({ version: "0.3.0" }) }), idle),
    ).toBe("available");
    expect(
      buttonState(
        response({
          available: update(),
          installing: {
            version: "0.2.1",
            startedAt: "2026-11-19T08:59:00.000Z",
            manual: false,
            stage: "pulling",
          },
        }),
        idle,
      ),
    ).toBe("installing");
    expect(buttonState(response({ available: update() }), { waiting: true, checking: false })).toBe(
      "installing",
    );
    // Mode off still shows what is new; "off" only when nothing is.
    const off = { mode: "off", automatic: false } as const;
    expect(buttonState(response({ ...off, available: update() }), idle)).toBe("available");
    expect(buttonState(response({ ...off, attention: update({ version: "0.3.0" }) }), idle)).toBe(
      "attention",
    );
    expect(buttonState(response(off), idle)).toBe("off");
    expect(buttonState(response(null), idle)).toBe("unreachable");
    // While the app restarts, the last answer may be an unreachable updater: still installing.
    expect(buttonState(response(null), { waiting: true, checking: false })).toBe("installing");
  });

  it("shows a failure only while the failed version is still offered", () => {
    const failed = {
      version: "0.2.1",
      result: "rolled-back" as const,
      message: "container web is unhealthy. 0.2.0 runs again.",
      finishedAt: "2026-11-19T08:00:00.000Z",
    };
    expect(buttonState(response({ available: update({ failed: "unhealthy" }), last: failed }), idle)).toBe(
      "failed",
    );
    // A newer version replaced the failed one.
    expect(buttonState(response({ available: update({ version: "0.2.2" }), last: failed }), idle)).toBe(
      "available",
    );
    expect(
      buttonState(
        response({ available: update({ failed: "unhealthy" }), last: { ...failed, result: "installed" } }),
        idle,
      ),
    ).toBe("available");
    expect(
      buttonState(
        response({
          attention: update({ version: "0.3.0", failed: "unhealthy" }),
          last: { ...failed, version: "0.3.0" },
        }),
        idle,
      ),
    ).toBe("failed");
  });
});

describe("failedInstall and installAction", () => {
  const rolledBack = {
    version: "0.2.1",
    result: "rolled-back" as const,
    message: "container web is unhealthy. 0.2.0 runs again.",
    finishedAt: "2026-11-19T08:00:00.000Z",
  };

  it("shows a failed last with its message, also without available.failed", () => {
    // E.g. the server never took the request: the updater does not mark the version.
    const status = response({
      available: update(),
      last: { ...rolledBack, result: "failed", message: "The server did not take the request." },
    });
    expect(buttonState(status, idle)).toBe("failed");
    expect(failedInstall(status)).toEqual({
      version: "0.2.1",
      message: "The server did not take the request.",
      offer: update(),
    });
  });

  it("offers to try again only while the version is offered", () => {
    // Not offered any more: shown only for the installation this tab followed, without an offer.
    const gone = response({ last: rolledBack });
    expect(failedInstall(gone)).toBeNull();
    expect(buttonState(gone, idle)).toBe("current");
    expect(failedInstall(gone, "0.2.1")).toMatchObject({ version: "0.2.1", offer: null });
    expect(buttonState(gone, { ...idle, followed: "0.2.1" })).toBe("failed");
  });

  it("installs anyway an attention offer only while the channel is not locked", () => {
    const attention = update({ version: "0.3.0" });
    expect(installAction(response({ attention })!.updater!, attention)).toBe("anyway");
    const locked = response({
      mode: "platform",
      channelLocked: "The image tag 0.2 set where the app is deployed decides which updates install.",
      attention,
    }).updater!;
    expect(installAction(locked, attention)).toBe("locked");
    expect(installAction(response({ available: update() }).updater!, update())).toBe("install");
    expect(installAction(response({ mode: "off", available: update() }).updater!, update())).toBe("off");
    expect(installAction(response({}).updater!, update())).toBeNull();
  });
});

describe("installOutcome", () => {
  const pending = { ...pendingInstall("0.2.1", NOW), confirmed: true };
  const after = (seconds: number) => NOW + seconds * 1000;
  const last = (
    result: "installed" | "failed" | "rolled-back" | "accepted",
    version = "0.2.1",
    finishedAt = "2026-11-19T09:01:00.000Z",
  ) => ({ version, result, message: `${result} message`, finishedAt });
  const installing = {
    version: "0.2.1",
    startedAt: "2026-11-19T09:00:00.000Z",
    manual: true,
    stage: "starting" as const,
  };
  const outcome = (answer: UpdatesResponse, attempt = pending, receivedAt = after(70)) =>
    installOutcome(attempt, answer, receivedAt).kind;

  it("waits until the updater names the result or the app runs the version", () => {
    expect(outcome(response({ available: update() }))).toBe("waiting");
    expect(outcome(response({ installing }))).toBe("waiting");
    expect(outcome(response({ last: last("installed") }))).toBe("done");
    expect(outcome(response({ last: last("installed", "0.2.2") }))).toBe("waiting");
    expect(outcome(response({ last: last("failed") }))).toBe("failed");
    expect(outcome(response({ last: last("rolled-back") }))).toBe("failed");
    // Nothing reports it any more, and the app runs it.
    expect(outcome(response({ installed: "0.2.1" }, "0.2.1"))).toBe("done");
  });

  it("keeps waiting while the updater reports the installation, though the app already runs it", () => {
    // On a server, the web container may answer before the worker is healthy; it may still roll back.
    expect(outcome(response({ installed: "0.2.1", installing }, "0.2.1"))).toBe("waiting");
    expect(
      outcome(response({ installed: "0.2.1", installing, last: last("installed", "0.2.0") }, "0.2.1")),
    ).toBe("waiting");
  });

  it("takes a failed last for the version as the result, with no available.failed", () => {
    const failed = response({ available: update(), last: last("rolled-back") });
    expect(outcome(failed)).toBe("failed");
    expect(failedInstall(failed, "0.2.1")?.message).toBe("rolled-back message");
  });

  it("ignores a last that finished before the attempt, and answers from before it", () => {
    const stale = last("failed", "0.2.1", "2026-11-19T08:59:59.000Z");
    expect(outcome(response({ available: update(), last: stale }))).toBe("waiting");
    expect(outcome(response({ last: { ...stale, result: "installed" } }))).toBe("waiting");
    expect(installOutcome(pending, response({ last: last("installed") }), NOW - 1).kind).toBe("waiting");
    // No status (the updater restarts with the app): no news, even when the app runs the version.
    expect(outcome({ ...response(null, "0.2.1"), error: "The update service is not reachable." })).toBe(
      "waiting",
    );
  });

  it("takes a platform's acceptance once the app runs the version", () => {
    const platform = { mode: "platform" as const, last: last("accepted") };
    expect(outcome(response(platform))).toBe("waiting");
    expect(outcome(response(platform, "0.2.1"))).toBe("done");
  });

  it("takes an acceptance without an app version only after an answer that followed an outage", () => {
    const accepted = response({ mode: "platform", last: last("accepted") }, null);
    expect(outcome(accepted)).toBe("waiting");
    // The cached answer from before the outage does not count.
    expect(outcome(accepted, { ...pending, outageAt: after(80) }, after(70))).toBe("waiting");
    expect(outcome(accepted, { ...pending, outageAt: after(80) }, after(90))).toBe("done");
  });

  it("leaves an unconfirmed attempt open until a status reports it", () => {
    const unconfirmed = pendingInstall("0.2.1", NOW);
    const nothing = response({ available: update() });
    // The deadline is a timer of its own (unconfirmedEnd): answers never end the wait.
    expect(installOutcome(unconfirmed, nothing, after(61))).toEqual({ kind: "waiting", confirmed: false });
    expect(installOutcome(unconfirmed, response(null), after(61)).kind).toBe("waiting");
    // A status that reports it confirms it.
    expect(installOutcome(unconfirmed, response({ installing }), after(30))).toEqual({
      kind: "waiting",
      confirmed: true,
    });
    expect(installOutcome(unconfirmed, response({ last: last("installed") }), after(90)).kind).toBe("done");
  });
});

describe("following an attempt", () => {
  // The admin clicks at 09:00:00.400; the updater writes whole seconds.
  const clickedAt = NOW + 400;
  const accepted = {
    version: "0.2.1",
    result: "accepted" as const,
    message: null,
    finishedAt: "2026-11-19T09:00:00Z",
  };
  const failed = {
    version: "0.2.1",
    result: "failed" as const,
    message: "The deploy link answered 500.",
    finishedAt: "2026-11-19T09:00:00Z",
  };
  const platform = (status: Partial<UpdaterStatus>, app: string | null = null) =>
    response({ mode: "platform", ...status }, app);

  it("takes an acceptance from the same second as the click after an ambiguous answer", () => {
    const attempt = afterInstallReply(
      pendingInstall("0.2.1", clickedAt, null),
      { kind: "failed", error: "Bad gateway" },
      clickedAt + 300,
    ).pending!;
    expect(attempt.confirmed).toBe(false);
    const answer = platform({ last: accepted }, "0.2.1");
    expect(freshLast(attempt, answer.updater!)).toEqual(accepted);
    expect(installOutcome(attempt, answer, clickedAt + 2_000).kind).toBe("done");
  });

  it("does not take the earlier result of the same second as a retry's own", () => {
    // The first attempt failed in this second; Try again follows in the same second.
    const retry = pendingInstall("0.2.1", clickedAt + 500, failed);
    const answer = platform({ available: update(), last: failed });
    expect(freshLast(retry, answer.updater!)).toBeNull();
    expect(installOutcome(retry, answer, clickedAt + 2_000).kind).toBe("waiting");
    // A new result of the same second counts.
    const again = { ...failed, message: "The deploy link answered 502.", result: "rolled-back" as const };
    expect(installOutcome(retry, platform({ last: again }), clickedAt + 2_500).kind).toBe("failed");
  });

  it("counts from installing.startedAt once a status reported it", () => {
    const attempt = observe(pendingInstall("0.2.1", clickedAt), {
      at: clickedAt + 1_000,
      response: response({
        installing: { version: "0.2.1", startedAt: "2026-11-19T09:00:01Z", manual: true, stage: "pulling" },
      }),
    });
    expect(attempt.installStartedAt).toBe("2026-11-19T09:00:01Z");
    expect(
      freshLast(attempt, response({ last: { ...failed, finishedAt: "2026-11-19T09:00:00Z" } }).updater!),
    ).toBeNull();
    expect(
      freshLast(attempt, response({ last: { ...failed, finishedAt: "2026-11-19T09:00:01Z" } }).updater!),
    ).not.toBeNull();
  });

  it("records an unreachable updater as an outage, then completes an acceptance without app version", () => {
    let attempt: PendingInstall = { ...pendingInstall("0.2.1", clickedAt), confirmed: true };
    const acceptedAnswer = platform({ last: accepted });
    // Before any outage, the cached app could still be the old one.
    expect(installOutcome(attempt, acceptedAnswer, clickedAt + 2_000).kind).toBe("waiting");
    const unreachable = { ...response(null, null), error: "The update service is not reachable." };
    attempt = observe(attempt, { at: clickedAt + 4_000, response: unreachable });
    expect(attempt).toMatchObject({
      outageAt: clickedAt + 4_000,
      answered: false,
      lastError: unreachable.error,
    });
    expect(installOutcome(attempt, unreachable, clickedAt + 4_000).kind).toBe("waiting");
    attempt = observe(attempt, { at: clickedAt + 6_000, response: acceptedAnswer });
    expect(installOutcome(attempt, acceptedAnswer, clickedAt + 6_000).kind).toBe("done");
  });

  it("ends an unconfirmed attempt by what the newest request brought", () => {
    let attempt: PendingInstall = { ...pendingInstall("0.2.1", clickedAt), reason: "Bad gateway" };
    // Every poll failed: it could not be confirmed, with the last error.
    attempt = observe(attempt, { at: clickedAt + 2_000, error: "Failed to fetch" });
    expect(unconfirmedEnd(attempt)).toEqual({ message: "notConfirmed", detail: "Failed to fetch" });
    // No poll answered at all: the reason of the install answer.
    expect(unconfirmedEnd({ ...attempt, lastError: null })).toEqual({
      message: "notConfirmed",
      detail: "Bad gateway",
    });
    // A reachable status answered without it: it did not start.
    attempt = observe(attempt, { at: clickedAt + 4_000, response: response({ available: update() }) });
    expect(unconfirmedEnd(attempt)).toEqual({ message: "notStarted", detail: "Bad gateway" });
  });

  it("ignores the installation an admin stopped waiting for, by identity or from the attempt", () => {
    const running = { version: "0.2.1", startedAt: "2026-11-19T09:00:01Z" };
    const seen = { ...pendingInstall("0.2.1", clickedAt), installStartedAt: running.startedAt };
    expect(isIgnored(ignoreInstall(seen), running)).toBe(true);
    expect(isIgnored(ignoreInstall(seen), { ...running, startedAt: "2026-11-19T09:20:00Z" })).toBe(false);
    expect(isIgnored(ignoreInstall(seen), { ...running, version: "0.2.2" })).toBe(false);
    // Never seen (the updater did not answer): the version from the attempt's start on.
    const unseen = ignoreInstall(pendingInstall("0.2.1", clickedAt));
    expect(isIgnored(unseen, { ...running, startedAt: "2026-11-19T09:00:00Z" })).toBe(true);
    expect(isIgnored(unseen, { ...running, startedAt: "2026-11-19T08:59:59Z" })).toBe(false);
    expect(isIgnored(null, running)).toBe(false);
  });

  it("takes too long from exactly 15 minutes on, when the timer renders", () => {
    expect(waitedTooLong(NOW, NOW + INSTALL_PATIENCE_MS - 1)).toBe(false);
    expect(waitedTooLong(NOW, NOW + INSTALL_PATIENCE_MS)).toBe(true);
    expect(waitedTooLong(NaN, NOW)).toBe(false);
  });

  it("shows a newer offer over an old failure, with the failure as a line", () => {
    const rolledBack = { ...failed, result: "rolled-back" as const, message: "container web is unhealthy." };
    const newer = response({ available: update({ version: "0.2.2" }), last: rolledBack });
    // Also for the installation this tab followed.
    expect(buttonState(newer, { ...idle, followed: "0.2.1" })).toBe("available");
    expect(replacedFailure(newer)).toEqual({ version: "0.2.1", message: "container web is unhealthy." });
    // Still offered: the failure itself, with Try again.
    const same = response({ available: update(), last: rolledBack });
    expect(buttonState(same, { ...idle, followed: "0.2.1" })).toBe("failed");
    expect(replacedFailure(same)).toBeNull();
    // Nothing offered: the failure the tab followed.
    expect(buttonState(response({ last: rolledBack }), { ...idle, followed: "0.2.1" })).toBe("failed");
  });
});

describe("afterInstallReply", () => {
  const attempt = pendingInstall("0.2.1", NOW);
  const installing = {
    version: "0.2.1",
    startedAt: "2026-11-19T08:59:58.000Z",
    manual: false,
    stage: "pulling" as const,
  };

  it("confirms an installation the updater took", () => {
    expect(afterInstallReply(attempt, { kind: "accepted", response: response({ installing }) }, NOW)).toEqual(
      {
        pending: { ...attempt, confirmed: true },
        refused: null,
      },
    );
    // Also when the 202 has a body that cannot be read.
    expect(afterInstallReply(attempt, { kind: "accepted", response: null }, NOW).pending?.confirmed).toBe(
      true,
    );
  });

  it("keeps the attempt after an ambiguous answer", () => {
    const timeout = "The update service did not answer within 10 seconds.";
    for (const reply of [
      { kind: "answer" as const, response: { ...response({}), error: timeout } },
      { kind: "answer" as const, response: { ...response(null), error: timeout } },
      { kind: "failed" as const, error: timeout },
    ]) {
      expect(afterInstallReply(attempt, reply, NOW)).toEqual({
        pending: { ...attempt, reason: timeout },
        refused: null,
      });
    }
  });

  it("forgets the attempt when the updater refuses", () => {
    const busy = "Another installation runs.";
    expect(
      afterInstallReply(
        attempt,
        { kind: "refused", response: { ...response({}), error: busy }, error: busy },
        NOW,
      ),
    ).toEqual({ pending: null, refused: busy });
    expect(
      afterInstallReply(attempt, { kind: "refused", response: null, error: "Not allowed" }, NOW),
    ).toEqual({
      pending: null,
      refused: "Not allowed",
    });
  });

  it("follows the installation a refusal reports instead", () => {
    const other = { ...installing, version: "0.2.2" };
    const refusal = { ...response({ installing: other }), error: "An installation runs." };
    expect(
      afterInstallReply(attempt, { kind: "refused", response: refusal, error: "An installation runs." }, NOW),
    ).toEqual({
      pending: {
        version: "0.2.2",
        startedAt: Date.parse("2026-11-19T08:59:58.000Z"),
        confirmed: true,
        reason: null,
        outageAt: null,
        earlier: null,
        installStartedAt: "2026-11-19T08:59:58.000Z",
        answered: false,
        lastError: null,
      },
      refused: null,
    });
  });

  it("adopts an installation from when it started, never later than now", () => {
    expect(adoptInstall(installing, null, NOW).startedAt).toBe(Date.parse(installing.startedAt));
    expect(adoptInstall({ ...installing, startedAt: "2026-11-19T09:05:00.000Z" }, null, NOW).startedAt).toBe(
      NOW,
    );
  });
});

describe("popover details", () => {
  it("says when an update installs", () => {
    expect(installsAt(update(), NOW)).toBeNull();
    expect(installsAt(update({ installsAt: "2026-11-20T02:00:00.000Z" }), NOW)).toEqual({
      kind: "on",
      date: "2026-11-20T02:00:00.000Z",
    });
    expect(installsAt(update({ installsAt: "2026-11-19T08:00:00.000Z" }), NOW)).toEqual({ kind: "next" });
  });

  it("shows eight notes and counts the rest", () => {
    const notes = Array.from({ length: 15 }, (_, index) => `Change ${index + 1}`);
    expect(shownNotes(update({ notes, changes: 40 }))).toEqual({ notes: notes.slice(0, 8), more: 32 });
    expect(shownNotes(update({ notes: notes.slice(0, 3), changes: 3 }))).toEqual({
      notes: notes.slice(0, 3),
      more: 0,
    });
  });

  it("reads cooldowns and keeps only web links", () => {
    expect(cooldownParts("3d")).toEqual({ count: 3, unit: "days" });
    expect(cooldownParts("12h")).toEqual({ count: 12, unit: "hours" });
    expect(cooldownParts("30m")).toEqual({ count: 30, unit: "minutes" });
    expect(cooldownParts("7200")).toEqual({ count: 2, unit: "hours" });
    expect(cooldownParts("0")).toBeNull();
    expect(cooldownParts("soon")).toBeNull();
    expect(safeUrl("https://github.com/meldgrove/handbook/releases")).toBe(
      "https://github.com/meldgrove/handbook/releases",
    );
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});
