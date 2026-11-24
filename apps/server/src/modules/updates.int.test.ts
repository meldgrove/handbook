import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
import { getDb } from "../db/client";
import { issueCredential } from "../auth/credentials";
import { resetConfigForTests } from "../config";
import { createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/*
 * The app's side of the update routes: who may use them, the origin check and
 * UPDATER_TOKEN. How the routes answer the updater is the shared handler's
 * (@meldgrove/ui/updates/server), tested in that package.
 */
const TOKEN = "updater-test-token-0123456789abcdef";
let updater: FakeUpdater;

function useUpdater(settings: { UPDATER_URL: string; UPDATER_TOKEN?: string }) {
  process.env.UPDATER_URL = settings.UPDATER_URL;
  if (settings.UPDATER_TOKEN === undefined) delete process.env.UPDATER_TOKEN;
  else process.env.UPDATER_TOKEN = settings.UPDATER_TOKEN;
  resetConfigForTests();
}

describe("updates API", () => {
  beforeAll(async () => {
    // As compose.yaml sets it up: the updater requires the app's UPDATER_TOKEN.
    updater = await startFakeUpdater({ token: TOKEN });
  });
  afterAll(async () => {
    await updater.close();
    delete process.env.UPDATER_URL;
    delete process.env.UPDATER_TOKEN;
    resetConfigForTests();
  });
  beforeEach(async () => {
    await resetDatabase();
    useUpdater({ UPDATER_URL: updater.url, UPDATER_TOKEN: TOKEN });
    updater.calls.length = 0;
    updater.respond(() => ({ body: updaterStatus() }));
  });

  it("is only for admins in the web app, and the updater gets UPDATER_TOKEN", async () => {
    const admin = await createUser({ isAdmin: true });
    const person = await createUser();
    const agent = await createToken(admin.id);
    const { secret: service } = await issueCredential(getDb(), {
      kind: "service",
      name: "Backup",
      userId: null,
      createdById: admin.id,
      expiresAt: null,
    });

    const paths: [string, string, unknown?][] = [
      ["GET", "/api/v1/admin/updates"],
      ["POST", "/api/v1/admin/updates/check", {}],
      ["POST", "/api/v1/admin/updates/install", { version: "0.2.1" }],
      ["POST", "/api/v1/admin/updates/channel", { channel: "preview" }],
    ];
    for (const [method, path, body] of paths) {
      expect((await request(method, path, { body })).status).toBe(401);
      expect((await request(method, path, { userId: person.id, body })).status).toBe(403);
      expect((await request(method, path, { token: agent, body })).status).toBe(403);
      expect((await request(method, path, { token: service, body })).status).toBe(403);
    }
    expect(updater.calls).toEqual([]);

    const status = await request("GET", "/api/v1/admin/updates", { userId: admin.id });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(status.body).toEqual({
      app: { version: null },
      reachable: true,
      updater: updaterStatus(),
      error: null,
    });
    expect(updater.calls).toEqual([
      { method: "GET", path: "/v1/status", body: null, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("installs the version an admin chose", async () => {
    const admin = await createUser({ isAdmin: true });
    const installing = updaterStatus({
      installing: {
        version: "0.2.1",
        startedAt: "2026-11-24T10:00:00.000Z",
        manual: true,
        stage: "requested",
      },
    });
    updater.respond(() => ({ status: 202, body: installing }));

    const response = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ reachable: true, updater: installing, error: null });
    expect(updater.calls).toEqual([
      {
        method: "POST",
        path: "/v1/install",
        body: { version: "0.2.1" },
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("protects changes against other sites, and asks only for versions", async () => {
    const admin = await createUser({ isAdmin: true });
    const foreign = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
      headers: { origin: "https://evil.example.net" },
    });
    expect(foreign.status).toBe(403);
    const wrong = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "latest" },
    });
    expect(wrong.status).toBe(400);
    expect(updater.calls).toEqual([]);
  });

  it("says that UPDATER_TOKEN is missing when the updater requires one", async () => {
    const admin = await createUser({ isAdmin: true });
    useUpdater({ UPDATER_URL: updater.url });
    const response = await request("GET", "/api/v1/admin/updates", { userId: admin.id });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ reachable: true, error: expect.stringContaining("UPDATER_TOKEN") });
    expect(updater.calls.map((call) => call.authorization)).toEqual([null]);
  });
});
