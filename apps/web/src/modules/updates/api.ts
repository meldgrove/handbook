import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateChannel, UpdatesResponse } from "@handbook/shared/api/updates";
import { api, ApiError } from "@/lib/api";

export const updatesKey = ["admin", "updates"] as const;
/** The check's mutation key: every update control shows a running check. */
export const CHECK_KEY = ["admin", "updates", "check"] as const;

/** A refusal of the updater (409) carries the latest status too; any other error throws. */
async function orRefusal(call: Promise<UpdatesResponse>): Promise<UpdatesResponse> {
  try {
    return await call;
  } catch (error) {
    const body = error instanceof ApiError && error.status === 409 ? error.body : null;
    if (body && typeof body === "object" && "reachable" in body) return body as UpdatesResponse;
    throw error;
  }
}

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
    refetchInterval: options.waitMs || 5 * 60_000,
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

export const useInstallUpdate = () =>
  useUpdatesMutation<string>((version) => api.post<UpdatesResponse>("/admin/updates/install", { version }));

export const useUpdateChannel = () =>
  useUpdatesMutation<UpdateChannel>((channel) =>
    api.post<UpdatesResponse>("/admin/updates/channel", { channel }),
  );
