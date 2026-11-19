import { describe, expect, it } from "vitest";
import type { Update, UpdaterStatus, UpdatesResponse } from "@handbook/shared/api/updates";
import {
  buttonState,
  cooldownParts,
  installOutcome,
  installsAt,
  pendingInstall,
  safeUrl,
  shownNotes,
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

describe("installOutcome", () => {
  const before = response({ available: update() });
  const pending = pendingInstall("0.2.1", before, NOW);
  const last = (result: "installed" | "failed" | "rolled-back" | "accepted", version = "0.2.1") => ({
    version,
    result,
    message: null,
    finishedAt: "2026-11-19T09:01:00.000Z",
  });

  it("waits until the app runs the version or the updater names its result", () => {
    expect(installOutcome(pending, before)).toBe("waiting");
    expect(
      installOutcome(
        pending,
        response({
          installing: {
            version: "0.2.1",
            startedAt: "2026-11-19T09:00:00.000Z",
            manual: true,
            stage: "starting",
          },
        }),
      ),
    ).toBe("waiting");
    expect(installOutcome(pending, response({ installed: "0.2.1" }, "0.2.1"))).toBe("done");
    expect(installOutcome(pending, response({ last: last("installed") }))).toBe("done");
    expect(installOutcome(pending, response({ last: last("installed", "0.2.2") }))).toBe("waiting");
    expect(installOutcome(pending, response({ last: last("failed") }))).toBe("failed");
    expect(installOutcome(pending, response({ last: last("rolled-back") }))).toBe("failed");
  });

  it("ignores the result of an earlier attempt", () => {
    const earlier = response({ available: update({ failed: "unhealthy" }), last: last("failed") });
    const again = pendingInstall("0.2.1", earlier, NOW);
    expect(again.lastFinishedAt).toBe("2026-11-19T09:01:00.000Z");
    expect(installOutcome(again, earlier)).toBe("waiting");
    expect(
      installOutcome(
        again,
        response({ last: { ...last("installed"), finishedAt: "2026-11-19T09:05:00.000Z" } }),
      ),
    ).toBe("done");
  });

  it("takes a platform's acceptance once the app changed or came back", () => {
    const accepted = response({ mode: "platform", last: last("accepted") });
    expect(installOutcome(pending, accepted)).toBe("waiting");
    expect(installOutcome({ ...pending, outage: true }, accepted)).toBe("done");
    expect(installOutcome(pending, response({ mode: "platform", last: last("accepted") }, "0.2.1-x"))).toBe(
      "done",
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
