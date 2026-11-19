import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateChannel, UpdatesResponse } from "@handbook/shared/api/updates";
import { ApiError, apiUrl, errorMessage, parseResponse } from "@/lib/api";
import { UNREADABLE_ANSWER, type InstallReply } from "./state";

export const updatesKey = ["admin", "updates"] as const;
/** The check's mutation key: every update control shows a running check. */
export const CHECK_KEY = ["admin", "updates", "check"] as const;

/** How long one status request may take. */
const STATUS_TIMEOUT_MS = 10_000;

const isUpdatesResponse = (body: unknown): body is UpdatesResponse =>
  typeof body === "object" && body !== null && "reachable" in body;

/**
 * The latest status a refusal (409) or, unless `serverErrors` is false, an
 * error of the updater (5xx) carries; null for any other error.
 */
function errorBody(error: unknown, serverErrors = true): UpdatesResponse | null {
  const answered =
    error instanceof ApiError && (error.status === 409 || (serverErrors && error.status >= 500));
  return answered && isUpdatesResponse(error.body) ? error.body : null;
}

/** A redirect or an HTML page instead of the API's JSON: a sign-in page of a proxy in front of the app. */
const isSignInAnswer = (response: Response) =>
  response.type === "opaqueredirect" ||
  (response.status >= 300 && response.status < 400) ||
  (response.ok && response.status !== 202 && /text\/html/i.test(response.headers.get("content-type") ?? ""));

/**
 * Calls an updates route without following redirects: a sign-in page
 * throws a 401 like an ended session. `response` is null when the body is
 * not an updates answer.
 */
async function call(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<{ status: number; response: UpdatesResponse | null }> {
  const response = await fetch(apiUrl(path), {
    method,
    credentials: "same-origin",
    headers:
      options.body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    redirect: "manual",
  });
  if (isSignInAnswer(response)) throw new ApiError(401, "sign_in_required", "Sign in again.");
  const body = await parseResponse<unknown>(response);
  return { status: response.status, response: isUpdatesResponse(body) ? body : null };
}

/** The status an updates route answers, also in a refusal (409) or an updater error (5xx); anything else throws. */
async function answerOf(
  request: Promise<{ response: UpdatesResponse | null }>,
  serverErrors = true,
): Promise<UpdatesResponse> {
  try {
    const { response } = await request;
    if (!response) throw new Error(UNREADABLE_ANSWER);
    return response;
  } catch (error) {
    const body = errorBody(error, serverErrors);
    if (body) return body;
    throw error;
  }
}

/** The session ended, lacks the right, or a proxy asks to sign in: polling stops until a later page load. */
export const signedOut = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

/**
 * The status; a request that takes longer than `timeoutMs` fails. A 5xx
 * stays an error (an outage while an installation is followed), with the
 * updater's message.
 */
export async function fetchUpdates(
  signal?: AbortSignal,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<UpdatesResponse> {
  const timeout = AbortSignal.timeout(Math.max(0, timeoutMs));
  try {
    return await answerOf(
      call("GET", "/admin/updates", { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }),
      false,
    );
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) {
      throw new Error("The app did not answer in time.", { cause: error });
    }
    if (
      error instanceof ApiError &&
      error.status >= 500 &&
      isUpdatesResponse(error.body) &&
      error.body.error
    ) {
      error.message = error.body.error;
    }
    throw error;
  }
}

/**
 * Admins: the updater's status. Asked on page load, every 5 minutes, and on
 * focus at most once a minute; `waitMs` polls faster during an installation.
 * Each request has a timeout (during an unconfirmed attempt at most until
 * `until`, its deadline). Never checks by itself. After a 401/403 or a
 * sign-in page, nothing asks again by itself (interval, focus, reconnect).
 */
export function useUpdates(
  options: { enabled?: boolean; waitMs?: number | false; until?: number | null } = {},
) {
  const asking = (query: { state: { error: unknown } }) => !signedOut(query.state.error);
  return useQuery({
    queryKey: updatesKey,
    queryFn: ({ signal }) =>
      fetchUpdates(signal, Math.min(STATUS_TIMEOUT_MS, (options.until ?? Infinity) - Date.now())),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: asking,
    refetchOnReconnect: asking,
    refetchInterval: (query) => (asking(query) ? options.waitMs || 5 * 60_000 : false),
    refetchIntervalInBackground: Boolean(options.waitMs),
    retry: false,
  });
}

function useUpdatesMutation<T>(path: string, body: (input: T) => unknown, mutationKey?: readonly string[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey,
    mutationFn: (input: T) => answerOf(call("POST", path, { body: body(input) })),
    onSuccess: (response) => queryClient.setQueryData(updatesKey, response),
  });
}

export const useCheckUpdates = () => useUpdatesMutation<void>("/admin/updates/check", () => ({}), CHECK_KEY);

/**
 * Installs a version and tells how the app answered: accepted (202, also
 * with a body it cannot read), a refusal (4xx; a 409 with the latest
 * status; a sign-in page), or an ambiguous answer (another 2xx, a 5xx, a
 * network error), after which the installation may still have started.
 * Never throws.
 */
export function useInstallUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (version: string): Promise<InstallReply> => {
      try {
        const { status, response } = await call("POST", "/admin/updates/install", { body: { version } });
        return { kind: status === 202 ? "accepted" : "answer", response };
      } catch (error) {
        const response = errorBody(error);
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return { kind: "refused", response, error: response?.error ?? error.message };
        }
        return { kind: "failed", error: response?.error ?? errorMessage(error) };
      }
    },
    onSuccess: (reply) => {
      const response = reply.kind === "failed" ? null : reply.response;
      if (response) queryClient.setQueryData(updatesKey, response);
    },
  });
}

export const useUpdateChannel = () =>
  useUpdatesMutation<UpdateChannel>("/admin/updates/channel", (channel) => ({ channel }));
