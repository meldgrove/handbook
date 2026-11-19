import { RefreshCw } from "lucide-react";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent } from "@meldgrove/ui/card";
import { Spinner } from "@meldgrove/ui/spinner";
import { UpdatesSettings, useUpdatesController, useUpdatesSnapshot } from "@meldgrove/ui/updates";
import { Page, PageHeader } from "@/components/layout/page";

/** Admins: the installed version, the update channel and automatic installs. */
export function UpdatesPage() {
  const controller = useUpdatesController();
  const { checking, status } = useUpdatesSnapshot();
  const t = controller.t;
  return (
    <Page className="max-w-3xl">
      <PageHeader
        title={t("updates")}
        description={t("sectionText", { app: controller.appName })}
        actions={
          <Button variant="outline" disabled={!status || checking} onClick={() => void controller.check()}>
            {checking ? <Spinner /> : <RefreshCw aria-hidden />}
            {t("checkForUpdates")}
          </Button>
        }
      />
      <Card>
        <CardContent>
          <UpdatesSettings />
        </CardContent>
      </Card>
    </Page>
  );
}
