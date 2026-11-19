import type { ReactNode } from "react";
import { fetchTransport, UpdateButton, UpdatesProvider, type UpdatesTransport } from "@meldgrove/ui/updates";
import { useIsAdmin } from "@/hooks/use-me";
import { apiUrl, sessionEnded } from "@/lib/api";

/** The deployment guide of the released version, for admins without an update service. */
const DEPLOYMENT_GUIDE =
  "https://github.com/meldgrove/handbook/blob/stable/docs/deployment.md#automatic-updates";

const routes = fetchTransport({ url: apiUrl("/admin/updates") });

/** The app's four update routes; a 401 shows the sign-in page, as every API request does. */
const transport: UpdatesTransport = {
  async request(request) {
    const answer = await routes.request(request);
    if (answer.status === 401) sessionEnded();
    return answer;
  },
};

/**
 * Admins: the update status that the header button and the Updates page
 * share (polling, installing, following the restart). Everyone else gets
 * 404 from the routes, so nothing asks for them.
 */
export function AdminUpdates({ appName, children }: { appName: string; children: ReactNode }) {
  if (!useIsAdmin()) return children;
  return (
    <UpdatesProvider
      appName={appName}
      // The systemd unit of a server set up as in docs/deployment.md (/srv/handbook).
      project="handbook"
      transport={transport}
      guideUrl={DEPLOYMENT_GUIDE}
      storageKey="handbook.update"
    >
      {children}
    </UpdatesProvider>
  );
}

/** The update icon in the header: admins only. */
export function AdminUpdateButton() {
  return useIsAdmin() ? <UpdateButton /> : null;
}
