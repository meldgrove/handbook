import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { AppEnv } from "./env";
import { AppError, zodFieldErrors } from "./errors";
import { authenticate, requestId, requestLog, sameOrigin } from "./middleware";
import { compression } from "./compression";
import { webApp } from "./static";
import { auth } from "../auth/auth";
import { CLIENT_IP_HEADER, clientIp } from "./client-ip";
import { API_MODULES } from "../modules";
import health from "../modules/health";
import { logger } from "../logger";
import { errorReportingSources, tracingMiddleware } from "../error-reporting";
import { MAX_IMPORT_BYTES } from "@knowledge/shared/limits";
import { config } from "../config";
import { mcpRoutes } from "../mcp/routes";
import { oauthRoutes } from "../oauth/routes";
import { rawRoutes } from "./raw";

export function createApp() {
  const app = new Hono<AppEnv>();
  const tracing = tracingMiddleware(app);
  if (tracing) app.use("*", tracing);
  app.use("*", requestId, requestLog, compression());
  // Uploaded files never run anything in the app's origin: a stricter policy
  // than the app's replaces it (this runs after secureHeaders below).
  app.use("/files/*", async (c, next) => {
    await next();
    c.res.headers.set("content-security-policy", "sandbox; default-src 'none'");
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", ...errorReportingSources()],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { ...error.extra, error: { code: error.code, message: error.message, fields: error.fields } },
        error.status,
      );
    }
    if (error instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "validation_error",
            message: "Check the highlighted fields",
            fields: zodFieldErrors(error),
          },
        },
        422,
      );
    }
    if (error instanceof HTTPException) {
      return c.json(
        {
          error: { code: error.status === 413 ? "payload_too_large" : "bad_request", message: error.message },
        },
        error.status,
      );
    }
    logger.error(
      { err: error, requestId: c.get("requestId"), route: `${c.req.method} ${c.req.routePath}` },
      "unhandled error",
    );
    return c.json({ error: { code: "internal_error", message: "Something went wrong. Try again." } }, 500);
  });

  app.route("/", health);

  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    // Replace any client-supplied value with the address the app trusts.
    const headers = new Headers(c.req.raw.headers);
    headers.set(CLIENT_IP_HEADER, clientIp(c) ?? "unknown");
    const body = c.req.method === "GET" ? undefined : c.req.raw.body;
    return auth().handler(
      new Request(c.req.raw.url, {
        method: c.req.method,
        headers,
        body,
        duplex: "half",
        signal: c.req.raw.signal,
      } as RequestInit),
    );
  });

  // Connected apps (MCP clients) talk OAuth and MCP from other origins.
  app.route("/", oauthRoutes());
  app.use("/mcp", authenticate);
  app.route(
    "/mcp",
    mcpRoutes((request, env) => app.fetch(request, env)),
  );

  const api = new Hono<AppEnv>();
  const uploadLimit = bodyLimit({ maxSize: config().MAX_UPLOAD_MB * 1024 * 1024 + 64 * 1024 });
  const importLimit = bodyLimit({ maxSize: MAX_IMPORT_BYTES + 64 * 1024 });
  const jsonLimit = bodyLimit({ maxSize: 2 * 1024 * 1024 });
  api.use(
    "*",
    (c, next) => {
      if (c.req.method === "POST" && c.req.path.endsWith("/files")) return uploadLimit(c, next);
      if (c.req.method === "POST" && c.req.path.endsWith("/import")) return importLimit(c, next);
      return jsonLimit(c, next);
    },
    sameOrigin,
    authenticate,
  );
  for (const module of API_MODULES) api.route("/", module);
  app.route("/api/v1", api);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  app.use("/files/*", authenticate);
  app.use("/s/*", authenticate);
  app.use("/llms.txt", authenticate);
  app.route("/", rawRoutes());

  app.route("/", webApp());
  return app;
}
