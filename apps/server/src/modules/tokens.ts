import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  tokenCreateSchema,
  type ConnectedApp,
  type ConnectInfo,
  type ServiceToken,
  type Token,
} from "@knowledge/shared/api/tokens";
import { config } from "../config";
import { getDb } from "../db/client";
import { credentials, oauthClients, oauthGrants, users } from "../db/schema";
import type { AppEnv } from "../http/env";
import { notFound } from "../http/errors";
import { idParam, jsonBody, requireAdmin, requireUser, requireWebUser } from "../http/middleware";
import { issueCredential } from "../auth/credentials";
import { audit } from "../core/audit";
import { decideRequest, describeRequest, revokeGrantTokens } from "../oauth/flow";

/**
 * Credentials of agents: personal tokens, connected apps (OAuth grants),
 * the consent screen's API, and read-only service tokens (admins).
 */
const router = new Hono<AppEnv>();

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function tokenView(row: typeof credentials.$inferSelect): Token {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    expiresAt: iso(row.expiresAt),
  };
}

function expiry(days: number | null) {
  return days === null ? null : new Date(Date.now() + days * 86_400_000);
}

router.get("/tokens", async (c) => {
  const principal = requireWebUser(c);
  const rows = await getDb()
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.userId, principal.id),
        eq(credentials.kind, "personal"),
        isNull(credentials.revokedAt),
      ),
    )
    .orderBy(desc(credentials.createdAt));
  return c.json({ items: rows.map(tokenView) });
});

router.post("/tokens", async (c) => {
  const principal = requireWebUser(c);
  const input = await jsonBody(c, tokenCreateSchema);
  const { id, secret } = await issueCredential(getDb(), {
    kind: "personal",
    name: input.name,
    userId: principal.id,
    createdById: principal.id,
    expiresAt: expiry(input.expiresInDays),
  });
  const [row] = await getDb().select().from(credentials).where(eq(credentials.id, id));
  return c.json({ ...tokenView(row!), secret }, 201);
});

router.delete("/tokens/:id", async (c) => {
  const principal = requireWebUser(c);
  const [row] = await getDb()
    .update(credentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(credentials.id, idParam(c)),
        eq(credentials.userId, principal.id),
        eq(credentials.kind, "personal"),
        isNull(credentials.revokedAt),
      ),
    )
    .returning({ id: credentials.id });
  if (!row) throw notFound("No such token");
  return c.body(null, 204);
});

router.get("/connected-apps", async (c) => {
  const principal = requireWebUser(c);
  const rows = await getDb()
    .select({ grant: oauthGrants, clientName: oauthClients.name })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, principal.id), isNull(oauthGrants.revokedAt)))
    .orderBy(desc(oauthGrants.createdAt));
  const items: ConnectedApp[] = rows.map((row) => {
    let redirectHost = row.grant.redirectUri;
    try {
      redirectHost = new URL(row.grant.redirectUri).host || row.grant.redirectUri;
    } catch {
      // Keep the URI as written.
    }
    return {
      id: row.grant.id,
      clientName: row.clientName,
      redirectHost,
      createdAt: row.grant.createdAt.toISOString(),
      lastUsedAt: iso(row.grant.lastUsedAt),
    };
  });
  return c.json({ items });
});

router.delete("/connected-apps/:id", async (c) => {
  const principal = requireWebUser(c);
  const id = idParam(c);
  await getDb().transaction(async (tx) => {
    const [grant] = await tx
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(
        and(eq(oauthGrants.id, id), eq(oauthGrants.userId, principal.id), isNull(oauthGrants.revokedAt)),
      );
    if (!grant) throw notFound("No such connected app");
    await revokeGrantTokens(tx, grant.id, { grant: true });
  });
  return c.body(null, 204);
});

router.get("/connect-info", (c) => {
  requireUser(c);
  const body: ConnectInfo = { appUrl: config().APP_URL, mcpUrl: config().mcpUrl };
  return c.json(body);
});

router.get("/oauth/requests/:id", async (c) => {
  const principal = requireWebUser(c);
  return c.json(await describeRequest(getDb(), principal, idParam(c)));
});

router.post("/oauth/requests/:id/approve", async (c) => {
  const principal = requireWebUser(c);
  return c.json({ redirectUrl: await decideRequest(getDb(), principal, idParam(c), true) });
});

router.post("/oauth/requests/:id/deny", async (c) => {
  const principal = requireWebUser(c);
  return c.json({ redirectUrl: await decideRequest(getDb(), principal, idParam(c), false) });
});

async function serviceTokens(): Promise<ServiceToken[]> {
  const rows = await getDb()
    .select({ credential: credentials, createdBy: users.email })
    .from(credentials)
    .leftJoin(users, eq(users.id, credentials.createdById))
    .where(and(eq(credentials.kind, "service"), isNull(credentials.revokedAt)))
    .orderBy(desc(credentials.createdAt));
  return rows.map((row) => ({ ...tokenView(row.credential), createdBy: row.createdBy }));
}

router.get("/admin/service-tokens", async (c) => {
  requireAdmin(c);
  return c.json({ items: await serviceTokens() });
});

router.post("/admin/service-tokens", async (c) => {
  const principal = requireAdmin(c);
  const input = await jsonBody(c, tokenCreateSchema);
  const created = await getDb().transaction(async (tx) => {
    const issued = await issueCredential(tx, {
      kind: "service",
      name: input.name,
      userId: null,
      createdById: principal.id,
      expiresAt: expiry(input.expiresInDays),
    });
    await audit(tx, principal, {
      action: "service_token.create",
      entityType: "service_token",
      entityId: issued.id,
      summary: `Created the service token “${input.name}”`,
    });
    return issued;
  });
  const [row] = await getDb().select().from(credentials).where(eq(credentials.id, created.id));
  return c.json({ ...tokenView(row!), createdBy: principal.email, secret: created.secret }, 201);
});

router.delete("/admin/service-tokens/:id", async (c) => {
  const principal = requireAdmin(c);
  await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(credentials.id, idParam(c)), eq(credentials.kind, "service"), isNull(credentials.revokedAt)),
      )
      .returning({ id: credentials.id, name: credentials.name });
    if (!row) throw notFound("No such service token");
    await audit(tx, principal, {
      action: "service_token.revoke",
      entityType: "service_token",
      entityId: row.id,
      summary: `Revoked the service token “${row.name}”`,
    });
  });
  return c.body(null, 204);
});

export default router;
