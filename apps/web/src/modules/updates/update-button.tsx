import { useEffect, useState, type ReactNode } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { Update, UpdatesResponse } from "@handbook/shared/api/updates";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsAdmin } from "@/hooks/use-me";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth-config";
import { useFormatter } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CHECK_KEY, updatesKey, useCheckUpdates, useInstallUpdate, useUpdates } from "./api";
import { messages } from "./messages";
import {
  INSTALL_PATIENCE_MS,
  POPOVER_STATES,
  STAGE_KEYS,
  buttonState,
  failedUpdate,
  installOutcome,
  installedVersion,
  installsAt,
  loadPending,
  pendingInstall,
  safeUrl,
  savePending,
  shownNotes,
  type ButtonState,
  type PendingInstall,
} from "./state";

/** The deployment guide of the released version, for admins without an update service. */
export const DEPLOYMENT_GUIDE =
  "https://github.com/meldgrove/handbook/blob/stable/docs/deployment.md#automatic-updates";
const POLL_WHILE_INSTALLING_MS = 2_000;
const RELOAD_AFTER_MS = 1_500;
/** The systemd unit of a server set up as in docs/deployment.md (/srv/handbook). */
const PROJECT = "handbook";

type Translate = ReturnType<typeof useT<typeof messages.en>>;

/** The update icon in the header: admins only. */
export function UpdateButton() {
  return useIsAdmin() ? <AdminUpdateButton /> : null;
}

function AdminUpdateButton() {
  const t = useT(messages);
  const appName = useAuthConfig()?.appName || "Handbook";
  const queryClient = useQueryClient();
  const [pending, setPendingState] = useState<PendingInstall | null>(loadPending);
  const setPending = (next: PendingInstall | null) => {
    savePending(next);
    setPendingState(next);
  };
  const updates = useUpdates({ waitMs: pending ? POLL_WHILE_INSTALLING_MS : false });
  const check = useCheckUpdates();
  const checking = useIsMutating({ mutationKey: CHECK_KEY }) > 0;
  const install = useInstallUpdate();
  const [open, setOpen] = useState(false);
  const [tooltip, setTooltip] = useState(false);
  const [confirm, setConfirm] = useState<{ update: Update; anyway: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The version that runs now: the page reloads in a moment. */
  const [done, setDone] = useState<string | null>(null);

  const data = updates.data;
  // A failed request while the app restarts is expected: keep asking.
  const restarting = Boolean(pending) && updates.isError;

  useEffect(() => {
    if (pending && !pending.outage && updates.errorUpdatedAt > pending.startedAt) {
      setPending({ ...pending, outage: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new error marks the outage
  }, [updates.errorUpdatedAt]);

  useEffect(() => {
    if (!data || done) return;
    if (!pending) {
      // An installation the updater runs (automatic, or another admin's) is waited for too.
      const running = data.updater?.installing;
      if (running) setPending(pendingInstall(running.version, data, Date.now()));
      return;
    }
    const outcome = installOutcome(pending, data);
    if (outcome === "done") {
      setDone(pending.version);
      setPending(null);
      toast.success(t("updated", { version: pending.version }));
      window.setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
    } else if (outcome === "failed") {
      setPending(null);
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each answer and each new installation
  }, [data, updates.dataUpdatedAt, pending?.version, pending?.startedAt, pending?.outage]);

  if (!data) return null;
  const state = buttonState(data, { waiting: Boolean(pending || done), checking });
  const hasPopover = POPOVER_STATES.has(state);
  const installingVersion = pending?.version ?? done ?? data.updater?.installing?.version ?? "";
  const label = buttonLabel(t, state, data, installingVersion, restarting);

  const runCheck = async (fromButton: boolean) => {
    try {
      const response = await check.mutateAsync();
      const error = response.error ?? response.updater?.error;
      if (error) {
        toast.error(error);
        return;
      }
      if (!fromButton) return;
      const next = buttonState(response, { waiting: false, checking: false });
      if (next === "current") {
        toast.success(t("upToDateVersion", { version: installedVersion(response) ?? t("unknownVersion") }));
      } else if (POPOVER_STATES.has(next)) {
        setOpen(true);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const runInstall = async (version: string) => {
    const before = queryClient.getQueryData<UpdatesResponse>(updatesKey);
    let response: UpdatesResponse;
    try {
      response = await install.mutateAsync(version);
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
    if (!response.error || response.updater?.installing?.version === version) {
      setOpen(false);
      setPending(pendingInstall(version, before, Date.now()));
    } else {
      toast.error(response.error);
    }
  };

  const askInstall = (update: Update, anyway: boolean) => {
    setOpen(false);
    setConfirm({ update, anyway });
    setConfirmOpen(true);
  };

  return (
    <>
      <Popover open={open && hasPopover} onOpenChange={setOpen}>
        <Tooltip open={tooltip && !(open && hasPopover)} onOpenChange={setTooltip}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                data-update-state={state}
                className={cn(
                  "relative rounded-full",
                  (state === "current" || state === "off" || state === "unreachable") &&
                    "text-muted-foreground",
                  state === "unreachable" && "opacity-60",
                )}
                onClick={(event) => {
                  if (hasPopover) return;
                  event.preventDefault();
                  if (state === "current") void runCheck(true);
                  else if (state === "unreachable") void updates.refetch();
                }}
              >
                <StateIcon state={state} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-3 text-sm">
          <PopoverBody
            state={state}
            data={data}
            pending={pending}
            installingVersion={installingVersion}
            restarting={restarting}
            appName={appName}
            onInstall={askInstall}
          />
          <PopoverFooter data={data} checking={checking} onCheck={() => void runCheck(false)} />
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirmOpen && confirm !== null}
        onOpenChange={setConfirmOpen}
        title={
          confirm
            ? t(confirm.anyway ? "confirmAnywayTitle" : "confirmTitle", { version: confirm.update.version })
            : ""
        }
        description={
          confirm?.anyway ? (
            <>
              {t("confirmAnywayText", { app: appName })} <ReleaseNotes update={confirm.update} />
            </>
          ) : (
            t("confirmText", { app: appName })
          )
        }
        confirmLabel={t("install")}
        destructive={confirm?.anyway}
        onConfirm={() => (confirm ? runInstall(confirm.update.version) : undefined)}
      />
    </>
  );
}

function buttonLabel(
  t: Translate,
  state: ButtonState,
  data: UpdatesResponse,
  installingVersion: string,
  restarting: boolean,
): string {
  const status = data.updater;
  const installed = installedVersion(data) ?? t("unknownVersion");
  switch (state) {
    case "checking":
      return t("checking");
    case "current":
      return t("upToDateVersion", { version: installed });
    case "available":
      return `${t("updateAvailable")} · ${status?.available?.version ?? ""}`;
    case "attention":
      return t("needsSteps", { version: status?.attention?.version ?? "" });
    case "installing":
      return restarting ? t("restarting") : t("installing", { version: installingVersion });
    case "failed":
      return t("failedTitle", { version: failedUpdate(data)?.version ?? "" });
    case "off":
      return t("off");
    case "unreachable":
      return data.reachable && data.error ? data.error : t("unreachable");
  }
}

function StateIcon({ state }: { state: ButtonState }) {
  const dot = (color: string) => (
    <span
      aria-hidden
      className={cn("ring-background absolute top-1 right-1 size-2 rounded-full ring-2", color)}
    />
  );
  switch (state) {
    case "checking":
      return <RefreshCw aria-hidden className="animate-spin motion-reduce:animate-none" />;
    case "available":
      return (
        <>
          <Download aria-hidden />
          {dot("bg-primary")}
        </>
      );
    case "attention":
      return (
        <>
          <Download aria-hidden />
          {dot("bg-warning")}
        </>
      );
    case "installing":
      return <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />;
    case "failed":
      return <TriangleAlert aria-hidden className="text-destructive" />;
    default:
      return <RefreshCw aria-hidden />;
  }
}

function ReleaseNotes({ update }: { update: Update }) {
  const t = useT(messages);
  const url = safeUrl(update.url);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-primary inline-flex items-center gap-1 underline-offset-4 hover:underline"
    >
      {t(update.preview ? "previewChanges" : "releaseNotes")}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

function Notes({ update }: { update: Update }) {
  const t = useT(messages);
  const { notes, more } = shownNotes(update);
  if (notes.length === 0 && more === 0) return null;
  return (
    <div className="space-y-1">
      {notes.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4 break-words">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}
      {more > 0 ? <p className="text-muted-foreground">{t("moreChanges", { count: more })}</p> : null}
    </div>
  );
}

function PopoverBody(props: {
  state: ButtonState;
  data: UpdatesResponse;
  pending: PendingInstall | null;
  installingVersion: string;
  restarting: boolean;
  appName: string;
  onInstall: (update: Update, anyway: boolean) => void;
}) {
  const t = useT(messages);
  const format = useFormatter();
  const { data } = props;
  const status = data.updater;
  const installed = installedVersion(data) ?? t("unknownVersion");
  // Mode off: the popover shows the update, but nothing can install from here.
  const installable = status?.mode !== "off";

  if (props.state === "installing") {
    const version = props.installingVersion;
    const stage = status?.installing?.stage;
    const stageText = props.restarting
      ? t("restarting")
      : stage
        ? t(STAGE_KEYS[stage], { version: installed })
        : status?.last?.result === "accepted"
          ? t("stageDeploying")
          : t("stageRequested");
    const tooLong = props.pending ? Date.now() - props.pending.startedAt > INSTALL_PATIENCE_MS : false;
    return (
      <>
        <PopoverHeader>
          <PopoverTitle>{t("installing", { version })}</PopoverTitle>
          <PopoverDescription role="status">{stageText}</PopoverDescription>
        </PopoverHeader>
        <p>{t("reloads", { app: props.appName })}</p>
        {tooLong ? <p className="text-destructive">{t("tooLong", { project: PROJECT })}</p> : null}
      </>
    );
  }

  if (props.state === "failed") {
    const update = failedUpdate(data);
    if (!update) return null;
    return (
      <>
        <PopoverHeader>
          <PopoverTitle>{t("failedTitle", { version: update.version })}</PopoverTitle>
          <PopoverDescription className="text-destructive break-words">
            {status?.last?.message ?? update.failed}
          </PopoverDescription>
        </PopoverHeader>
        <p>{t("stillRunning", { version: installed })}</p>
        {installable ? (
          <Button
            className="w-full"
            onClick={() => props.onInstall(update, update.version === status?.attention?.version)}
          >
            {t("tryAgain")}
          </Button>
        ) : (
          <OffNote />
        )}
      </>
    );
  }

  if (props.state === "available" && status?.available) {
    const update = status.available;
    const when = installsAt(update, Date.now());
    return (
      <>
        <PopoverHeader>
          <PopoverTitle>{t("updateAvailable")}</PopoverTitle>
          <PopoverDescription className="flex flex-wrap items-center gap-2">
            <span className="break-all">
              {update.publishedAt
                ? t("versionAge", { version: update.version, age: format.relative(update.publishedAt) })
                : update.version}
            </span>
            {update.preview ? <Badge variant="secondary">{t("preview")}</Badge> : null}
          </PopoverDescription>
        </PopoverHeader>
        <Notes update={update} />
        <ReleaseNotes update={update} />
        {when ? (
          <p className="text-muted-foreground">
            {when.kind === "on" ? t("installsOn", { date: format.dateTime(when.date) }) : t("installsNext")}
          </p>
        ) : null}
        {status.attention ? (
          <p className="text-muted-foreground">
            {t("alsoNeedsSteps", { version: status.attention.version })}
          </p>
        ) : null}
        {installable ? (
          <Button className="w-full" onClick={() => props.onInstall(update, false)}>
            <Download aria-hidden />
            {t("installNow")}
          </Button>
        ) : (
          <OffNote />
        )}
      </>
    );
  }

  if (props.state === "attention" && status?.attention) {
    const update = status.attention;
    return (
      <>
        <PopoverHeader>
          <PopoverTitle>{t("needsSteps", { version: update.version })}</PopoverTitle>
          <PopoverDescription>{t("needsStepsText")}</PopoverDescription>
        </PopoverHeader>
        <Notes update={update} />
        <ReleaseNotes update={update} />
        {installable ? (
          <Button variant="outline" className="w-full" onClick={() => props.onInstall(update, true)}>
            {t("installAnyway")}
          </Button>
        ) : (
          <OffNote />
        )}
      </>
    );
  }

  if (props.state === "off") {
    return (
      <PopoverHeader>
        <PopoverTitle>{t("off")}</PopoverTitle>
      </PopoverHeader>
    );
  }
  return null;
}

/** In mode off, in place of the install buttons: nothing can install from here. */
function OffNote() {
  const t = useT(messages);
  const [before, after] = t("offCannotInstall").split("{guide}");
  return (
    <p className="text-muted-foreground">
      {before}
      <GuideLink />
      {after}
    </p>
  );
}

export function GuideLink({ children }: { children?: ReactNode }) {
  const t = useT(messages);
  return (
    <a href={DEPLOYMENT_GUIDE} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children ?? t("deploymentGuide")}
    </a>
  );
}

function PopoverFooter(props: { data: UpdatesResponse; checking: boolean; onCheck: () => void }) {
  const t = useT(messages);
  const format = useFormatter();
  const status = props.data.updater;
  if (!status) return null;
  return (
    <div className="text-muted-foreground space-y-1 border-t pt-3 text-xs">
      <p>
        {t("installed", {
          version: installedVersion(props.data) ?? t("unknownVersion"),
          channel: t(status.channel),
        })}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span>
          {status.checkedAt ? t("checked", { time: format.relative(status.checkedAt) }) : t("neverChecked")}
        </span>
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          disabled={props.checking}
          onClick={props.onCheck}
        >
          {t("checkNow")}
        </Button>
      </div>
      {status.error ? (
        <p className="text-destructive break-words">{t("checkFailed", { error: status.error })}</p>
      ) : null}
    </div>
  );
}
