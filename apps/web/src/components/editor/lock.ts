import { lockLostSchema, type LockHolder } from "@knowledge/shared/api/pages";

/**
 * The edit lock of the live editor (docs/architecture.md, "Edit locks and
 * drafts") as a state machine:
 *
 *   acquiring → held (renewing) → released
 *       ↓          ↓ 409 lock_lost
 *     locked     lost
 *   (someone else; editors may take over → held)
 */
export type LockState =
  | { status: "acquiring" }
  | { status: "held"; token: string; renewSeconds: number }
  | { status: "locked"; holder: LockHolder }
  | { status: "lost"; by: string | null }
  | { status: "released" }
  | { status: "failed"; message: string };

export type LockEvent =
  | { type: "acquired"; token: string; renewSeconds: number }
  | { type: "locked"; holder: LockHolder }
  | { type: "lost"; by: string | null }
  | { type: "released" }
  | { type: "failed"; message: string }
  | { type: "retry" };

export function lockReducer(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case "acquired":
      return { status: "held", token: event.token, renewSeconds: event.renewSeconds };
    case "locked":
      return { status: "locked", holder: event.holder };
    case "lost":
      // Only a held lock can be lost; a released one stays released.
      return state.status === "held" ? { status: "lost", by: event.by } : state;
    case "released":
      return { status: "released" };
    case "failed":
      return state.status === "held" ? state : { status: "failed", message: event.message };
    case "retry":
      return { status: "acquiring" };
  }
}

/** The holder of a 423 `page_locked` answer. */
export function readLockHolder(body: unknown): LockHolder | null {
  const lock = (body as { lock?: unknown } | null)?.lock as LockHolder | undefined;
  return lock && typeof lock === "object" && typeof lock.since === "string" && lock.user ? lock : null;
}

/** Who took a lock over, from a 409 `lock_lost` answer (`lockLostSchema`). */
export function readLostBy(body: unknown): string | null {
  const parsed = lockLostSchema.safeParse(body);
  return parsed.success ? (parsed.data.takenOverBy?.name ?? null) : null;
}

/** The token of a held lock, for saving; null otherwise. */
export function lockToken(state: LockState): string | null {
  return state.status === "held" ? state.token : null;
}
