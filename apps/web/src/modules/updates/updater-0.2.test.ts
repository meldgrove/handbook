import { describe, expect, it } from "vitest";
import { updaterStatusSchema, type UpdatesResponse } from "@handbook/shared/api/updates";
import { buttonState, failedUpdate } from "./state";

/** Answers captured from Updater 0.2 (against GHCR and GitHub), shared with the server's tests. */
const samples = import.meta.glob<unknown>("../../../../server/src/test/fixtures/updater-0.2/*.json", {
  eager: true,
  import: "default",
});

function sample(name: string): UpdatesResponse {
  const raw = samples[`../../../../server/src/test/fixtures/updater-0.2/${name}.json`];
  if (raw === undefined) throw new Error(`No sample ${name}`);
  const updater = updaterStatusSchema.parse(raw);
  return { app: { version: updater.installed }, reachable: true, updater, error: null };
}

const stateOf = (name: string) => buttonState(sample(name), { waiting: false, checking: false });

describe("the button with the real answers of Updater 0.2", () => {
  it("parses every sample", () => {
    expect(Object.keys(samples).length).toBeGreaterThanOrEqual(7);
    for (const raw of Object.values(samples)) expect(updaterStatusSchema.safeParse(raw).success).toBe(true);
  });

  it("shows off for mode off, where nothing can install", () => {
    expect(stateOf("status-off-available-attention")).toBe("off");
  });

  it("offers the update a server installs", () => {
    expect(stateOf("status-host-available")).toBe("available");
  });

  it("is current when the platform decides and offers nothing", () => {
    expect(stateOf("status-platform-locked")).toBe("current");
  });

  it("shows a running installation", () => {
    expect(stateOf("status-installing")).toBe("installing");
    expect(stateOf("install-202")).toBe("installing");
  });

  it("shows a rolled-back installation as failed, also after switching to Preview", () => {
    for (const name of ["status-failed", "status-preview"]) {
      expect(stateOf(name)).toBe("failed");
      expect(failedUpdate(sample(name))).toMatchObject({
        version: "0.1.3",
        failed: "container library-web-1 is unhealthy",
      });
    }
  });
});
