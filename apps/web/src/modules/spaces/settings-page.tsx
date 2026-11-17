import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Lock } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page as PageLayout, PageHeader } from "@/components/layout/page";
import { spaceQuery } from "@/components/page/queries";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { MembersCard } from "./members-card";
import { messages } from "./messages";
import { GeneralCard, PageTypesCard, PropertiesCard } from "./schema-cards";

/** Settings of a space (owners): name, editors, properties, page types; admins archive. */
export function SettingsPage({ space: slug }: { space: string }) {
  const t = useT(messages);
  const queryClient = useQueryClient();
  const space = useQuery(spaceQuery(slug));
  const [archiving, setArchiving] = useState(false);

  if (space.error) {
    return (
      <PageLayout>
        <ErrorState error={space.error} onRetry={() => void space.refetch()} />
      </PageLayout>
    );
  }
  if (!space.data) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  const data = space.data;
  const back = (
    <Button variant="link" className="h-auto px-0 text-sm" asChild>
      <Link to="/s/$space" params={{ space: slug }}>
        <ArrowLeft />
        {data.name}
      </Link>
    </Button>
  );
  if (!data.abilities.manage) {
    return (
      <PageLayout>
        {back}
        <EmptyState icon={<Lock />} title={t("onlyOwners")} />
      </PageLayout>
    );
  }

  const toggleArchive = async () => {
    try {
      await api.post(`/spaces/${encodeURIComponent(slug)}/${data.archived ? "unarchive" : "archive"}`);
      await queryClient.invalidateQueries({ queryKey: ["space", slug] });
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
      toast.success(data.archived ? t("unarchivedDone") : t("archivedDone"));
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  return (
    <PageLayout className="max-w-4xl">
      <div className="space-y-2">
        {back}
        <PageHeader title={t("settingsTitle", { space: data.name })} />
      </div>
      <GeneralCard key={`general-${data.updatedAt}`} space={data} />
      <MembersCard space={data} />
      <PropertiesCard key={`properties-${data.updatedAt}`} space={data} />
      <PageTypesCard key={`types-${data.updatedAt}`} space={data} />
      {data.abilities.manageOwners ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("archiveTitle")}</CardTitle>
            <CardDescription>{t("archiveHelp")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.archived ? (
              <Button variant="outline" onClick={() => void toggleArchive()}>
                {t("unarchive")}
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => setArchiving(true)}>
                {t("archive")}
              </Button>
            )}
          </CardContent>
          <ConfirmDialog
            open={archiving}
            onOpenChange={setArchiving}
            title={t("archiveConfirm", { space: data.name })}
            description={t("archiveHelp")}
            confirmLabel={t("archive")}
            destructive
            onConfirm={toggleArchive}
          />
        </Card>
      ) : null}
    </PageLayout>
  );
}
