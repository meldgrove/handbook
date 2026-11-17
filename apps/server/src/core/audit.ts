import { lt, sql } from "drizzle-orm";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { auditLog } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";

/** Records a change by an admin or owner. `summary` must never contain secrets. */
export async function audit(
  db: DbOrTx,
  actor: UserPrincipal | null,
  entry: { action: string; entityType: string; entityId?: string | null; summary: string },
) {
  await db.insert(auditLog).values({
    actorUserId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary.slice(0, 500),
  });
}

/** Deletes entries older than AUDIT_LOG_DAYS (the worker's cleanup); 0 keeps them all. */
export async function pruneAuditLog(db: DbOrTx, days = config().AUDIT_LOG_DAYS): Promise<number> {
  if (days === 0) return 0;
  const result = await db
    .delete(auditLog)
    .where(lt(auditLog.createdAt, sql`now() - make_interval(days => ${days})`));
  return result.rowCount ?? 0;
}
