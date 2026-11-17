import { Hono, type Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { config } from "../config";
import type { AppEnv } from "../http/env";
import { publicCors } from "../oauth/routes";
import { apiClient } from "./client";
import { createMcpServer } from "./server";

/**
 * The Model Context Protocol endpoint for AI agents, at /mcp
 * (docs/agents.md).
 *
 * - Streamable HTTP transport, stateless: every POST gets a new server and
 *   transport; answers are JSON. GET (event streams) and DELETE (sessions)
 *   answer 405.
 * - Bearer tokens only: personal tokens, access tokens of connected apps
 *   (OAuth), service tokens (read tools only). Without one: 401 with the
 *   protected resource metadata, so clients can start the OAuth sign-in.
 * - Tools call the REST API in-process with the caller's credentials.
 */

/** Hands a request to the application, with the bindings of the request being served. */
export type AppFetch = (request: Request, env: object | undefined) => Response | Promise<Response>;

const UNAUTHORIZED = -32001;
const METHOD_NOT_ALLOWED = -32000;

function rpcError(
  c: Context<AppEnv>,
  status: 401 | 405,
  code: number,
  message: string,
  headers: Record<string, string>,
) {
  return c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status, headers);
}

export function mcpRoutes(fetch: AppFetch) {
  const mcp = new Hono<AppEnv>();
  mcp.use("*", publicCors);

  mcp.post("/", async (c) => {
    const principal = c.get("principal");
    if (!principal) {
      return rpcError(
        c,
        401,
        UNAUTHORIZED,
        "Sign in: connect this app, or send Authorization: Bearer <token>",
        {
          "WWW-Authenticate": `Bearer resource_metadata="${config().APP_URL}/.well-known/oauth-protected-resource/mcp"`,
        },
      );
    }
    const env = c.env as object | undefined;
    const api = apiClient(async (request) => fetch(request, env), c.req.raw, c.get("requestId"));
    const server = createMcpServer(api);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  mcp.all("/", (c) =>
    rpcError(
      c,
      405,
      METHOD_NOT_ALLOWED,
      "Method not allowed: this server is stateless; send POST requests.",
      {
        Allow: "POST",
      },
    ),
  );

  return mcp;
}
