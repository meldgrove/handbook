import { createRoute, notFound, redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { meQuery } from "@/hooks/use-me";
import { authConfigQuery } from "@/lib/auth-config";
import { AppLayout } from "@/components/layout/app-layout";
import { rootRoute } from "./root";

/**
 * The signed-in application. Every module's routes are children of this
 * route (`getParentRoute: () => appRoute`); it loads the signed-in person
 * first and sends everyone else to the sign-in page.
 */
export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    // The app's name as well: the update status of admins takes it once, when the layout mounts.
    const appName = context.queryClient.ensureQueryData(authConfigQuery).catch(() => undefined);
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw redirect({ to: "/sign-in", search: { redirect: location.href } });
      }
      throw error;
    }
    await appName;
  },
  component: AppLayout,
});

/** `beforeLoad` of admin pages: others see "not found" (the server enforces access too). */
export function requireAdmin() {
  return async ({ context }: { context: { queryClient: QueryClient } }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me.isAdmin) throw notFound();
  };
}
