import { useState, type FormEvent } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { UpdateChannel, UpdaterStatus } from "@handbook/shared/api/updates";
import { Page, PageHeader } from "@/components/layout/page";
import { ErrorState, LoadingState } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth-config";
import { useFormatter } from "@/lib/format";
import { CHECK_KEY, useCheckUpdates, useUpdateChannel, useUpdates } from "./api";
import { messages } from "./messages";
import { cooldownParts } from "./state";
import { GuideLink } from "./update-button";

type Translate = ReturnType<typeof useT<typeof messages.en>>;

function cooldownText(t: Translate, cooldown: string): string {
  const parts = cooldownParts(cooldown);
  return parts ? t(parts.unit, { count: parts.count }) : cooldown;
}

/** "On: releases install automatically after 3 days, between 02:00 and 05:00 (UTC)." and the others. */
export function automaticText(t: Translate, status: UpdaterStatus): string {
  if (status.mode === "platform") return t("automaticPlatform");
  if (status.mode === "off" || !status.automatic) return t("automaticOff");
  const [from, to] = status.window?.split("-") ?? [];
  const window = from && to ? t("automaticWindow", { from, to, timezone: status.timezone }) : "";
  if (status.channel === "preview") return t("automaticOnPreview", { window });
  const cooldown = status.cooldown && cooldownParts(status.cooldown) ? status.cooldown : null;
  return cooldown
    ? t("automaticOn", { cooldown: cooldownText(t, cooldown), window })
    : t("automaticOnNoCooldown", { window });
}

/** Admins: the installed version, the update channel and automatic installs. */
export function UpdatesPage() {
  const t = useT(messages);
  const format = useFormatter();
  const appName = useAuthConfig()?.appName || "Handbook";
  const updates = useUpdates();
  const check = useCheckUpdates();
  const checking = useIsMutating({ mutationKey: CHECK_KEY }) > 0;
  const saveChannel = useUpdateChannel();
  const [choice, setChoice] = useState<UpdateChannel | null>(null);

  const runCheck = async () => {
    try {
      const response = await check.mutateAsync();
      const error = response.error ?? response.updater?.error;
      if (error) toast.error(error);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const data = updates.data;
  const status = data?.updater ?? null;
  const selected = choice ?? status?.channel ?? null;
  const locked = status?.channelLocked ?? null;
  const disabled = !status || Boolean(locked) || saveChannel.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    try {
      const response = await saveChannel.mutateAsync(selected);
      // Saved only when the updater answered with the chosen channel.
      if (response.reachable && response.updater?.channel === selected) {
        toast.success(t("channelSaved"));
      } else {
        toast.error(response.error ?? t("channelNotSaved"));
      }
      setChoice(null);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Page className="max-w-3xl">
      <PageHeader
        title={t("title")}
        description={t("description", { app: appName })}
        actions={
          <Button variant="outline" disabled={!status || checking} onClick={() => void runCheck()}>
            {checking ? <Spinner /> : <RefreshCw aria-hidden />}
            {t("checkForUpdates")}
          </Button>
        }
      />
      {updates.isLoading ? (
        <LoadingState />
      ) : !data ? (
        <ErrorState error={updates.error} onRetry={() => void updates.refetch()} />
      ) : (
        <Card>
          <CardContent className="space-y-6">
            {!status ? (
              <Alert>
                <AlertCircle aria-hidden />
                <AlertDescription>
                  <p>
                    {t("unreachableText")} (<GuideLink />
                    ).
                  </p>
                  {data.reachable && data.error ? <p className="text-xs break-words">{data.error}</p> : null}
                </AlertDescription>
              </Alert>
            ) : data.error ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden />
                <AlertDescription className="break-words">{data.error}</AlertDescription>
              </Alert>
            ) : null}
            <dl className="space-y-3 text-sm">
              {[
                { term: t("installedVersion"), value: data.app.version ?? t("development"), strong: true },
                { term: t("channel"), value: status ? t(status.channel) : "–", strong: true },
                {
                  term: t("automaticInstalls"),
                  value: status ? automaticText(t, status) : "–",
                  strong: false,
                },
              ].map((row) => (
                <div key={row.term} className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
                  <dt className="text-muted-foreground">{row.term}</dt>
                  <dd className={row.strong ? "font-medium break-all" : undefined}>{row.value}</dd>
                </div>
              ))}
            </dl>
            <form onSubmit={(event) => void submit(event)} className="space-y-4">
              <FieldSet disabled={disabled}>
                <FieldLegend variant="label">{t("channelLegend")}</FieldLegend>
                {locked ? <FieldDescription>{locked}</FieldDescription> : null}
                <RadioGroup
                  value={selected ?? ""}
                  onValueChange={(value) => setChoice(value as UpdateChannel)}
                  disabled={disabled}
                >
                  <FieldLabel htmlFor="update-channel-stable">
                    <Field orientation="horizontal" data-disabled={disabled}>
                      <RadioGroupItem value="stable" id="update-channel-stable" />
                      <FieldContent>
                        <FieldTitle>
                          {t("stable")}
                          <Badge variant="secondary">{t("recommended")}</Badge>
                        </FieldTitle>
                        <FieldDescription>
                          {status?.cooldown && cooldownParts(status.cooldown)
                            ? t("stableText", { cooldown: cooldownText(t, status.cooldown) })
                            : t("stableTextNoCooldown")}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                  <FieldLabel htmlFor="update-channel-preview">
                    <Field orientation="horizontal" data-disabled={disabled}>
                      <RadioGroupItem value="preview" id="update-channel-preview" />
                      <FieldContent>
                        <FieldTitle>{t("preview")}</FieldTitle>
                        <FieldDescription>{t("previewText")}</FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                </RadioGroup>
                <FieldDescription>{t("switchBack")}</FieldDescription>
              </FieldSet>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground text-xs">
                  {status
                    ? [
                        status.checkedAt
                          ? t("checked", { time: format.relative(status.checkedAt) })
                          : t("neverChecked"),
                        t("updaterVersion", { version: status.updater }),
                      ].join(" · ")
                    : null}
                </p>
                <Button type="submit" disabled={disabled || !selected || selected === status?.channel}>
                  {saveChannel.isPending ? <Spinner /> : null}
                  {t("saveChannel")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
