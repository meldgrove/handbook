import { useCallback, useEffect, useReducer, useRef } from "react";
import type { LockResponse } from "@knowledge/shared/api/pages";
import { LOCK_RENEW_SECONDS } from "@knowledge/shared/limits";
import { errorMessage } from "@/lib/api";
import { apiErrorOf, rawRequest } from "./raw-api";
import { lockReducer, readLockHolder, readLostBy, type LockState } from "./lock";

/**
 * Takes and keeps the edit lock of a page while the live editor is open:
 * renews it every LOCK_RENEW_SECONDS (saying whether the person typed since
 * the last renewal), notices when someone took it over, and releases it on
 * unmount (best effort, also while the page closes).
 */
export function useEditLock(pageId: string, enabled: boolean) {
  const [state, dispatch] = useReducer(lockReducer, { status: "acquiring" } as LockState);
  const typed = useRef(false);
  // Only the latest acquisition counts (React may mount the editor twice in development).
  const attempt = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const acquire = useCallback(
    async (takeover: boolean) => {
      const current = ++attempt.current;
      try {
        const response = await rawRequest("POST", `/pages/${pageId}/lock${takeover ? "/takeover" : ""}`);
        if (current !== attempt.current) return;
        if (response.ok) {
          const lock = response.body as LockResponse;
          dispatch({
            type: "acquired",
            token: lock.token,
            renewSeconds: lock.renewSeconds || LOCK_RENEW_SECONDS,
          });
          return;
        }
        const holder = response.status === 423 ? readLockHolder(response.body) : null;
        if (holder) dispatch({ type: "locked", holder });
        else dispatch({ type: "failed", message: apiErrorOf(response).message });
      } catch (error) {
        if (current === attempt.current) dispatch({ type: "failed", message: errorMessage(error) });
      }
    },
    [pageId],
  );

  useEffect(() => {
    if (!enabled) return;
    // A tick later: a mount that React undoes at once (development) never asks.
    const timer = window.setTimeout(() => void acquire(false), 0);
    return () => window.clearTimeout(timer);
  }, [acquire, enabled]);

  const held = state.status === "held";
  const token = state.status === "held" ? state.token : null;
  const renewSeconds = state.status === "held" ? state.renewSeconds : LOCK_RENEW_SECONDS;

  useEffect(() => {
    if (!held || !token) return;
    const timer = window.setInterval(() => {
      const active = typed.current;
      typed.current = false;
      void rawRequest("POST", `/pages/${pageId}/lock/renew`, { body: { token, active } })
        .then((response) => {
          if (response.ok) return;
          if (response.status === 409 || response.status === 404 || response.status === 423) {
            dispatch({
              type: "lost",
              by: readLostBy(response.body) ?? readLockHolder(response.body)?.user.name ?? null,
            });
          }
        })
        .catch(() => undefined);
    }, renewSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [held, token, renewSeconds, pageId]);

  const release = useCallback(() => {
    attempt.current += 1;
    const current = stateRef.current;
    if (current.status !== "held") return;
    dispatch({ type: "released" });
    void rawRequest("DELETE", `/pages/${pageId}/lock?token=${encodeURIComponent(current.token)}`, {
      keepalive: true,
    }).catch(() => undefined);
  }, [pageId]);

  // Release when the editor closes: unmount, or the browser tab goes away.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [enabled, release]);

  return {
    state,
    /** Call on every keystroke: the next renewal tells the server the person is active. */
    markActivity: useCallback(() => {
      typed.current = true;
    }, []),
    takeOver: useCallback(() => acquire(true), [acquire]),
    retry: useCallback(() => {
      dispatch({ type: "retry" });
      void acquire(false);
    }, [acquire]),
    release,
    /** After a successful save, the server released the lock. */
    forget: useCallback(() => dispatch({ type: "released" }), []),
  };
}
