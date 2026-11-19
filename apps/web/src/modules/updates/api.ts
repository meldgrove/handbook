import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateChannel, UpdatesResponse } from "@handbook/shared/api/updates";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { InstallReply } from "./state";

export const updatesKey = ["admin", "updates"] as const;
/** The check's mutation key: every update control shows a running check. */
export const CHECK_KEY = ["admin", "updates", "check"] as const;

/** The latest status a refusal of the updater (409) carries; null for any other error. */
function refusalBody(error: unknown): UpdatesResponse | null {
  const body = error instanceof ApiError && error.status === 409 ? error.body : null;
  return body && typeof body === "object" && "reachable" in body ? (body as UpdatesResponse) : null;
}

/** A refusal of the updater (409) carries the latest status too; any other error throws. */
async function orRefusal(call: Promise<UpdatesResponse>): Promise<UpdatesResponse> {
  try {
    return await call;
  } catch (error) {
    const body = refusalBody(error);
    if (body) return body;
    throw error;
  }
}

/** The session ended or lacks the right: polling stops until a later page load or focus. */
export const signedOut = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

export const fetchUpdates = (signal?: AbortSignal) =>
  orRefusal(api.get<UpdatesResponse>("/admin/updates", undefined, signal));

/**
 * Admins: the updater's status. Asked on page load, every 5 minutes, and on
 * focus at most once a minute; `waitMs` polls faster during an installation.
 * Never checks by itself.
 */
export function useUpdates(options: { enabled?: boolean; waitMs?: number | false } = {}) {
  return useQuery({
    queryKey: updatesKey,
    queryFn: ({ signal }) => fetchUpdates(signal),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (signedOut(query.state.error) ? false : options.waitMs || 5 * 60_000),
    refetchIntervalInBackground: Boolean(options.waitMs),
    retry: false,
  });
}

function useUpdatesMutation<T>(
  call: (input: T) => Promise<UpdatesResponse>,
  mutationKey?: readonly string[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey,
    mutationFn: (input: T) => orRefusal(call(input)),
    onSuccess: (response) => queryClient.setQueryData(updatesKey, response),
  });
}

export const useCheckUpdates = () =>
  useUpdatesMutation<void>(() => api.post<UpdatesResponse>("/admin/updates/check"), CHECK_KEY);

/**
 * Installs a version and tells how the app answered: an answer (2xx), a
 * refusal (4xx; a 409 with the latest status), or no usable answer (a
 * network error or 5xx), after which the installation may still have
 * started. Never throws.
 */
export function useInstallUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (version: string): Promise<InstallReply> => {
      try {
        const response = await api.post<UpdatesResponse>("/admin/updates/install", { version });
        return { kind: "answer", response };
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          const response = refusalBody(error);
          return { kind: "refused", response, error: response?.error ?? error.message };
        }
        return { kind: "failed", error: errorMessage(error) };
      }
    },
    onSuccess: (reply) => {
      const response = reply.kind === "failed" ? null : reply.response;
      if (response) queryClient.setQueryData(updatesKey, response);
    },
  });
}

export const useUpdateChannel = () =>
  useUpdatesMutation<UpdateChannel>((channel) =>
    api.post<UpdatesResponse>("/admin/updates/channel", { channel }),
  );
