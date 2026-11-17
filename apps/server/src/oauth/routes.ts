import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { config } from "../config";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { logger } from "../logger";
import { authenticateClient, OAuthError, registerClient } from "./clients";
import {
  AuthorizePageError,
  exchangeCode,
  refreshTokens,
  revokeToken,
  SCOPE,
  startAuthorization,
} from "./flow";

/**
 * The OAuth 2.1 authorization server for connected apps (MCP clients):
 * /.well-known metadata, /oauth/register, /oauth/authorize, /oauth/token
 * and /oauth/revoke (docs/architecture.md, "OAuth server").
 */

/** Any origin, no cookies: for apps that call from a browser (MCP inspectors, web clients). */
export const publicCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
  exposeHeaders: ["www-authenticate", "mcp-session-id"],
  maxAge: 86_400,
});

export function protectedResourceMetadata() {
  const settings = config();
  return {
    resource: settings.mcpUrl,
    authorization_servers: [settings.APP_URL],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: settings.APP_NAME,
    resource_documentation: `${settings.APP_URL}/settings`,
  };
}

export function authorizationServerMetadata() {
  const base = config().APP_URL;
  const methods = ["none", "client_secret_post", "client_secret_basic"];
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: methods,
    revocation_endpoint_auth_methods_supported: methods,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/settings`,
  };
}

function oauthError(c: Context<AppEnv>, error: OAuthError) {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (error.status === 401) headers["www-authenticate"] = 'Basic realm="oauth"';
  return c.json({ error: error.error, error_description: error.description }, error.status, headers);
}

async function formBody(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  let raw: Record<string, unknown>;
  if (type.includes("application/json")) {
    raw = ((await c.req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  } else {
    raw = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  }
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === "string") body[key] = value;
  return body;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function errorPage(c: Context<AppEnv>, message: string) {
  const name = escapeHtml(config().APP_NAME);
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}: cannot connect</title></head>` +
      `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">` +
      `<h1 style="font-size: 1.25rem">The app cannot connect to ${name}</h1><p>${escapeHtml(message)}</p></body></html>`,
    400,
  );
}

export function oauthRoutes() {
  const app = new Hono<AppEnv>();
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/*",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/*",
    "/oauth/register",
    "/oauth/token",
    "/oauth/revoke",
  ]) {
    app.use(path, publicCors);
  }
  app.use("/oauth/register", bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/oauth/token", bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/oauth/revoke", bodyLimit({ maxSize: 16 * 1024 }));

  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata()));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata()));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata()));

  app.post("/oauth/register", async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null);
      return c.json(await registerClient(getDb(), body), 201, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error);
      throw error;
    }
  });

  app.get("/oauth/authorize", async (c) => {
    try {
      return c.redirect(await startAuthorization(getDb(), c.req.query()), 302);
    } catch (error) {
      if (error instanceof AuthorizePageError) return errorPage(c, error.message);
      throw error;
    }
  });

  app.post("/oauth/token", async (c) => {
    try {
      const body = await formBody(c);
      const client = await authenticateClient(getDb(), body, c.req.header("authorization"));
      const grantType = body.grant_type;
      let tokens;
      if (grantType === "authorization_code") tokens = await exchangeCode(getDb(), client, body);
      else if (grantType === "refresh_token") tokens = await refreshTokens(getDb(), client, body);
      else throw new OAuthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
      return c.json(tokens, 200, { "cache-control": "no-store", pragma: "no-cache" });
    } catch (error) {
      if (error instanceof OAuthError) {
        if (error.error !== "invalid_grant") logger.info({ error: error.error }, "token request refused");
        return oauthError(c, error);
      }
      throw error;
    }
  });

  app.post("/oauth/revoke", async (c) => {
    try {
      const body = await formBody(c);
      const client = await authenticateClient(getDb(), body, c.req.header("authorization"));
      await revokeToken(getDb(), client, body.token);
      return c.body(null, 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error);
      throw error;
    }
  });

  return app;
}
