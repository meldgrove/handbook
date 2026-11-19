import { Card, CardContent } from "@meldgrove/ui/card";
import { UpdatesSettings, useUpdatesController } from "@meldgrove/ui/updates";
import { Page, PageHeader } from "@/components/layout/page";

/** Admins: the installed version, the update channel and automatic installs. */
export function UpdatesPage() {
  const controller = useUpdatesController();
  return (
    <Page className="max-w-3xl">
      <PageHeader
        title={controller.t("updates")}
        description={controller.t("sectionText", { app: controller.appName })}
      />
      <Card>
        <CardContent>
          <UpdatesSettings />
        </CardContent>
      </Card>
    </Page>
  );
}
