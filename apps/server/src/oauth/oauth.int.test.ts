import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../config";
import { createUser, request, resetDatabase, testApp } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const REDIRECT = "https://client.example.org/callback";
const MCP_HEADERS = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function form(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await testApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function authorize(params: Record<string, string>) {
  const response = await testApp().request(`/oauth/authorize?${new URLSearchParams(params).toString()}`);
  return { status: response.status, location: response.headers.get("location"), text: await response.text() };
}

async function mcpCall(token: string | undefined, method = "tools/list") {
  return request("POST", "/mcp", {
    token,
    body: { jsonrpc: "2.0", id: 1, method, params: {} },
    headers: MCP_HEADERS,
  });
}

/** Signs a person in through the whole flow and returns the token response. */
async function connect(userId: string, clientId: string, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const started = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: "http://localhost:3000/mcp",
    ...extra,
  });
  expect(started.status).toBe(302);
  const requestId = new URL(started.location!).searchParams.get("request")!;
  const consent = await request("GET", `/api/v1/oauth/requests/${requestId}`, { userId });
  expect(consent.status).toBe(200);
  const approved = await request("POST", `/api/v1/oauth/requests/${requestId}/approve`, { userId });
  const redirect = new URL(approved.body.redirectUrl);
  expect(redirect.searchParams.get("state")).toBe("state-1");
  expect(redirect.searchParams.get("iss")).toBe("http://localhost:3000");
  const code = redirect.searchParams.get("code")!;
  return { code, verifier, requestId, consent: consent.body };
}

describe("OAuth for connected apps", () => {
  beforeEach(resetDatabase);
  afterEach(() => {
    delete process.env.OAUTH_ALLOW_PRIVATE_CLIENT_URLS;
    resetConfigForTests();
  });

  it("publishes metadata with CORS", async () => {
    const resource = await testApp().request("/.well-known/oauth-protected-resource/mcp", {
      headers: { origin: "https://claude.ai" },
    });
    expect(resource.headers.get("access-control-allow-origin")).toBe("*");
    expect(await resource.json()).toMatchObject({
      resource: "http://localhost:3000/mcp",
      authorization_servers: ["http://localhost:3000"],
    });
    const server = await (await testApp().request("/.well-known/oauth-authorization-server")).json();
    expect(server).toMatchObject({
      issuer: "http://localhost:3000",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
    });
    const preflight = await testApp().request("/oauth/token", {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("registers, authorizes with PKCE, refreshes, and revokes", async () => {
    const ada = await createUser({ name: "Ada" });
    const registered = await testApp().request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: "Test client",
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_secret?: string };
    expect(client.client_secret).toBeUndefined();

    const { code, verifier, requestId, consent } = await connect(ada.id, client.client_id);
    expect(consent).toMatchObject({
      clientName: "Test client",
      redirectHost: "client.example.org",
      registration: "dynamic",
    });

    // Another person cannot use the same consent screen.
    const other = await createUser();
    expect((await request("GET", `/api/v1/oauth/requests/${requestId}`, { userId: other.id })).status).toBe(
      404,
    );

    expect(
      (
        await form("/oauth/token", {
          grant_type: "authorization_code",
          code,
          code_verifier: "x".repeat(43),
          client_id: client.client_id,
        })
      ).body,
    ).toMatchObject({ error: "invalid_grant" });
    const tokens = await form("/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("cache-control")).toBe("no-store");
    expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "knowledge" });
    // The code works once.
    expect(
      (
        await form("/oauth/token", {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: client.client_id,
        })
      ).status,
    ).toBe(400);
    // Reusing the code revoked what it gave.
    expect((await mcpCall(tokens.body.access_token)).status).toBe(401);

    const second = await connect(ada.id, client.client_id);
    const fresh = await form("/oauth/token", {
      grant_type: "authorization_code",
      code: second.code,
      code_verifier: second.verifier,
      client_id: client.client_id,
    });
    expect((await mcpCall(fresh.body.access_token)).status).toBe(200);

    const apps = await request("GET", "/api/v1/connected-apps", { userId: ada.id });
    expect(apps.body.items).toEqual([
      expect.objectContaining({ clientName: "Test client", redirectHost: "client.example.org" }),
    ]);

    const refreshed = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: fresh.body.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(fresh.body.refresh_token);
    const reused = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: fresh.body.refresh_token,
      client_id: client.client_id,
    });
    expect(reused.body).toMatchObject({ error: "invalid_grant" });

    expect(
      (await request("DELETE", `/api/v1/connected-apps/${apps.body.items[0].id}`, { userId: ada.id })).status,
    ).toBe(204);
    expect((await mcpCall(refreshed.body.access_token)).status).toBe(401);
  });

  it("checks confidential clients, redirect URIs and PKCE", async () => {
    const ada = await createUser();
    const registered = await testApp().request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    const client = (await registered.json()) as {
      client_id: string;
      client_secret: string;
      token_endpoint_auth_method: string;
    };
    expect(client.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(client.client_secret).toMatch(/^kn_cs_/);

    const bad = await testApp().request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.org/callback"] }),
    });
    expect(await bad.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const wrongRedirect = await authorize({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://other.example.org/cb",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.location).toBeNull();
    const noPkce = await authorize({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: "s",
    });
    expect(new URL(noPkce.location!).searchParams.get("error")).toBe("invalid_request");

    const { code, verifier } = await connect(ada.id, client.client_id);
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString("base64")}`;
    const refused = await form(
      "/oauth/token",
      { grant_type: "authorization_code", code, code_verifier: verifier },
      { authorization: basic("wrong") },
    );
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ error: "invalid_client" });
    const accepted = await form(
      "/oauth/token",
      { grant_type: "authorization_code", code, code_verifier: verifier },
      { authorization: basic(client.client_secret) },
    );
    expect(accepted.status).toBe(200);

    // Denying sends the person back with access_denied.
    const { challenge } = pkce();
    const started = await authorize({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const requestId = new URL(started.location!).searchParams.get("request")!;
    const denied = await request("POST", `/api/v1/oauth/requests/${requestId}/deny`, { userId: ada.id });
    expect(new URL(denied.body.redirectUrl).searchParams.get("error")).toBe("access_denied");
  });

  it("reads client metadata documents, and refuses private addresses", async () => {
    const ada = await createUser();
    let served = 0;
    const server = http.createServer((_request, response) => {
      served += 1;
      const port = (server.address() as AddressInfo).port;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          client_id: `http://127.0.0.1:${port}/client.json`,
          client_name: "Document client",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const clientId = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client.json`;
    try {
      // Without the development switch: http and private addresses are refused.
      const refused = await authorize({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT });
      expect(refused.status).toBe(400);
      expect(refused.text).toContain("https");
      const privateHttps = await authorize({
        response_type: "code",
        client_id: "https://127.0.0.1:9/client.json",
        redirect_uri: REDIRECT,
      });
      expect(privateHttps.status).toBe(400);
      expect(privateHttps.text).toContain("private network");
      expect(served).toBe(0);

      process.env.OAUTH_ALLOW_PRIVATE_CLIENT_URLS = "true";
      resetConfigForTests();
      const { code, verifier, consent } = await connect(ada.id, clientId);
      expect(consent).toMatchObject({ clientName: "Document client", registration: "metadata_document" });
      const tokens = await form("/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
      });
      expect(tokens.status).toBe(200);
      // Cached for an hour: a second sign-in does not fetch again.
      await connect(ada.id, clientId);
      expect(served).toBe(1);
    } finally {
      server.close();
    }
  });
});
