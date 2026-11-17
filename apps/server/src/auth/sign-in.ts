import { and, desc, eq, sql } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import { accounts, users } from "../db/schema";
import { logger } from "../logger";
import { isEnvironmentAdmin } from "./bootstrap";

/** The claims of a JWT, without checking its signature (the sign-in already verified the ID token). */
export function jwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A claim by name; a dotted name reads a nested claim, e.g. `realm_access.roles`. */
export function readClaim(claims: Record<string, unknown> | null, name: string): unknown {
  if (!claims) return undefined;
  if (name in claims) return claims[name];
  let value: unknown = claims;
  for (const part of name.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Group names from a claim value: a list, or one comma-separated string. */
export function claimGroups(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

const trimSlashes = (group: string) => group.replace(/^\/+|\/+$/g, "");

/**
 * True when one of `groups` is one of `allowed`, or below it: Keycloak
 * group paths count their subgroups (`/staff` admits `/staff/it`).
 * Leading slashes do not matter.
 */
export function inAllowedGroup(groups: string[], allowed: string[]): boolean {
  const wanted = allowed.map(trimSlashes);
  return groups
    .map(trimSlashes)
    .some((group) => wanted.some((item) => group === item || group.startsWith(`${item}/`)));
}

let userInfoEndpoint: string | null | undefined;

async function userInfoClaims(accessToken: string): Promise<Record<string, unknown> | null> {
  if (userInfoEndpoint === undefined) {
    const discovery = await fetch(
      `${config().OIDC_ISSUER.replace(/\/+$/, "")}/.well-known/openid-configuration`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await discovery.json().catch(() => null)) as { userinfo_endpoint?: unknown } | null;
    userInfoEndpoint = typeof body?.userinfo_endpoint === "string" ? body.userinfo_endpoint : null;
  }
  if (!userInfoEndpoint) return null;
  const response = await fetch(userInfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The provider's userinfo endpoint answered HTTP ${response.status}`);
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

/** The groups of the sign-in: the claim in the ID token, else in the userinfo response. */
async function signInGroups(account: {
  idToken: string | null;
  accessToken: string | null;
}): Promise<string[]> {
  const claim = config().OIDC_GROUPS_CLAIM;
  const fromIdToken = readClaim(jwtClaims(account.idToken), claim);
  if (fromIdToken !== undefined) return claimGroups(fromIdToken);
  if (!account.accessToken) return [];
  return claimGroups(readClaim(await userInfoClaims(account.accessToken), claim));
}

/**
 * Decides at every sign-in whether a person may use the app: not blocked,
 * an allowed email domain (ALLOWED_EMAIL_DOMAINS) and in an allowed group
 * (ACCESS_GROUPS). Admins from ADMIN_EMAILS always may. Returns false to
 * refuse the session.
 */
export async function checkAccessAtSignIn(userId: string): Promise<boolean> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return false;
  if (isEnvironmentAdmin(user.email)) {
    await db
      .update(users)
      .set({ isAdmin: true, adminSource: "environment", blockedAt: null, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
    return true;
  }
  if (user.blockedAt) {
    logger.info({ userId }, "sign-in refused: blocked");
    return false;
  }
  const domains = config().allowedEmailDomains;
  const domain = user.email.split("@")[1]?.toLowerCase() ?? "";
  if (domains.length > 0 && !domains.includes(domain)) {
    logger.info({ userId }, "sign-in refused: email domain not allowed");
    return false;
  }
  const groups = config().accessGroups;
  if (groups.length > 0) {
    const [account] = await db
      .select({ idToken: accounts.idToken, accessToken: accounts.accessToken })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "oidc")))
      .orderBy(desc(accounts.updatedAt))
      .limit(1);
    if (!account) return false;
    try {
      if (!inAllowedGroup(await signInGroups(account), groups)) {
        logger.info({ userId }, "sign-in refused: not in ACCESS_GROUPS");
        return false;
      }
    } catch (error) {
      logger.warn({ err: error, userId }, "sign-in refused: could not read the groups");
      return false;
    }
  }
  return true;
}
