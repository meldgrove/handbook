import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { Update, UpdaterStatus, UpdatesResponse } from "@handbook/shared/api/updates";
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
import { CHECK_KEY, signedOut, useCheckUpdates, useInstallUpdate, useUpdates } from "./api";
import { messages } from "./messages";
import {
  INSTALL_PATIENCE_MS,
  POPOVER_STATES,
  STAGE_KEYS,
  adoptInstall,
  afterInstallReply,
  buttonState,
  failedInstall,
  installAction,
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

/** Identifies an installation the updater reports, so "Stop waiting" does not follow it again. */
const installationKey = (installing: { version: string; startedAt: string }) =>
  `${installing.version}@${installing.startedAt}`;

function AdminUpdateButton() {
  const t = useT(messages);
  const appName = useAuthConfig()?.appName || "Handbook";
  const [pending, setPendingState] = useState<PendingInstall | null>(loadPending);
  // The attempt as last set, for answers that arrive while an install request runs.
  const pendingRef = useRef(pending);
  const setPending = (next: PendingInstall | null) => {
    savePending(next);
    pendingRef.current = next;
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
  /** The version whose failure this tab saw while following it: shown even when no longer offered. */
  const [followed, setFollowed] = useState<string | null>(null);
  /** The installation an admin stopped waiting for (installationKey). */
  const [ignored, setIgnored] = useState<string | null>(null);
  const reloadTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reloadTimer.current), []);

  const data = updates.data;
  // A failed request while the app restarts is expected: keep asking.
  const restarting = Boolean(pending) && updates.isError && !signedOut(updates.error);

  useEffect(() => {
    // Only a new failed request marks the outage; a signed-out answer is no outage.
    if (pending && restarting && updates.errorUpdatedAt > pending.startedAt) {
      setPending({ ...pending, outageAt: updates.errorUpdatedAt });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new error marks the outage
  }, [updates.errorUpdatedAt]);

  const follow = (next: PendingInstall) => {
    setFollowed(null);
    setPending(next);
  };

  useEffect(() => {
    if (!data || done) return;
    const now = Date.now();
    const running = data.updater?.installing;
    const current = pendingRef.current;
    if (current) {
      const outcome = installOutcome(current, data, updates.dataUpdatedAt, now);
      if (outcome.kind === "done") {
        setDone(current.version);
        setPending(null);
        toast.success(t("updated", { version: current.version }));
        reloadTimer.current = window.setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
      } else if (outcome.kind === "failed") {
        setPending(null);
        setFollowed(current.version);
        setOpen(true);
      } else if (outcome.kind === "not-started") {
        setPending(null);
        toast.error(t("notStarted"), { description: current.reason ?? undefined });
      } else if (running && running.version !== current.version) {
        // Another installation runs (another admin, an automatic one): follow that one.
        follow(adoptInstall(running, now));
      } else if (outcome.confirmed && !current.confirmed) {
        setPending({ ...current, confirmed: true, reason: null });
      }
      return;
    }
    // An installation the updater runs (automatic, or another admin's) is followed too.
    if (running && installationKey(running) !== ignored) follow(adoptInstall(running, now));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each answer and each new installation
  }, [data, updates.dataUpdatedAt, pending?.version, pending?.startedAt]);

  if (!data) return null;
  const state = buttonState(data, { waiting: Boolean(pending || done), checking, followed });
  const hasPopover = POPOVER_STATES.has(state);
  const installingVersion = pending?.version ?? done ?? data.updater?.installing?.version ?? "";
  const label = buttonLabel(t, state, data, installingVersion, restarting, followed);

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
    // Remembered before the request: an answer that never arrives may still have started it.
    const attempt = pendingInstall(version, Date.now());
    setOpen(false);
    follow(attempt);
    const reply = await install.mutateAsync(version);
    const current = pendingRef.current;
    // A status may have decided meanwhile (a result, another installation): that stands.
    if (current?.version !== attempt.version || current.startedAt !== attempt.startedAt) return;
    const next = afterInstallReply(current, reply, Date.now());
    setPending(next.pending);
    if (next.refused) toast.error(next.refused);
  };

  const stopWaiting = () => {
    const running = data.updater?.installing;
    setIgnored(running ? installationKey(running) : null);
    setPending(null);
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
            followed={followed}
            installingVersion={installingVersion}
            restarting={restarting}
            appName={appName}
            onInstall={askInstall}
            onStopWaiting={stopWaiting}
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
  followed: string | null,
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
      return t("failedTitle", { version: failedInstall(data, followed)?.version ?? "" });
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

/** The install button of an update, or why there is none (mode off, an image tag that does not reach it). */
function InstallControl(props: {
  status: UpdaterStatus;
  update: Update;
  label: "installNow" | "installAnyway" | "tryAgain";
  appName: string;
  onInstall: (update: Update, anyway: boolean) => void;
}) {
  const t = useT(messages);
  const action = installAction(props.status, props.update);
  if (action === "off") return <OffNote />;
  if (action === "locked") {
    return (
      <p className="text-muted-foreground">
        {t("lockedTag", { app: props.appName, version: props.update.version })}
      </p>
    );
  }
  if (action === null) return null;
  const anyway = action === "anyway";
  return (
    <Button
      variant={anyway && props.label === "installAnyway" ? "outline" : "default"}
      className="w-full"
      onClick={() => props.onInstall(props.update, anyway)}
    >
      {props.label === "installNow" ? <Download aria-hidden /> : null}
      {t(props.label)}
    </Button>
  );
}

function PopoverBody(props: {
  state: ButtonState;
  data: UpdatesResponse;
  pending: PendingInstall | null;
  followed: string | null;
  installingVersion: string;
  restarting: boolean;
  appName: string;
  onInstall: (update: Update, anyway: boolean) => void;
  onStopWaiting: () => void;
}) {
  const t = useT(messages);
  const format = useFormatter();
  const { data } = props;
  const status = data.updater;
  const installed = installedVersion(data) ?? t("unknownVersion");

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
    const running = status?.installing;
    const since = props.pending?.startedAt ?? (running ? Date.parse(running.startedAt) : NaN);
    const tooLong = Date.now() - since > INSTALL_PATIENCE_MS;
    return (
      <>
        <PopoverHeader>
          <PopoverTitle>{t("installing", { version })}</PopoverTitle>
          <PopoverDescription role="status">{stageText}</PopoverDescription>
        </PopoverHeader>
        <p>{t("reloads", { app: props.appName })}</p>
        {tooLong ? (
          <>
            <p className="text-destructive">{t("tooLong", { project: PROJECT })}</p>
            {props.pending ? (
              <Button variant="outline" className="w-full" onClick={props.onStopWaiting}>
                {t("stopWaiting")}
              </Button>
            ) : null}
          </>
        ) : null}
      </>
    );
  }

  if (props.state === "failed") {
    const failure = failedInstall(data, props.followed);
    if (!failure) return null;
    return (
      <>
        <PopoverHeader>
          <PopoverTitle>{t("failedTitle", { version: failure.version })}</PopoverTitle>
          {failure.message ? (
            <PopoverDescription className="text-destructive break-words">
              {failure.message}
            </PopoverDescription>
          ) : null}
        </PopoverHeader>
        <p>{t("stillRunning", { version: installed })}</p>
        {failure.offer && status ? (
          <InstallControl
            status={status}
            update={failure.offer}
            label="tryAgain"
            appName={props.appName}
            onInstall={props.onInstall}
          />
        ) : null}
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
        <InstallControl
          status={status}
          update={update}
          label="installNow"
          appName={props.appName}
          onInstall={props.onInstall}
        />
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
        <InstallControl
          status={status}
          update={update}
          label="installAnyway"
          appName={props.appName}
          onInstall={props.onInstall}
        />
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
