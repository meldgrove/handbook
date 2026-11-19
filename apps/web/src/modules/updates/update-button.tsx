import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
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
import { CHECK_KEY, signedOut, updatesKey, useCheckUpdates, useInstallUpdate, useUpdates } from "./api";
import { messages } from "./messages";
import {
  INSTALL_PATIENCE_MS,
  POPOVER_STATES,
  RECONCILE_MS,
  STAGE_KEYS,
  adoptInstall,
  afterInstallReply,
  buttonState,
  failedInstall,
  ignoreInstall,
  installAction,
  installOutcome,
  installedVersion,
  installsAt,
  isIgnored,
  loadPending,
  observe,
  pendingInstall,
  replacedFailure,
  safeUrl,
  savePending,
  shownNotes,
  unconfirmedEnd,
  waitedTooLong,
  type ButtonState,
  type IgnoredInstall,
  type LastResult,
  type PendingInstall,
} from "./state";

/** The deployment guide of the released version, for admins without an update service. */
export const DEPLOYMENT_GUIDE =
  "https://github.com/meldgrove/handbook/blob/stable/docs/deployment.md#automatic-updates";
const POLL_WHILE_INSTALLING_MS = 2_000;
/** Shown for an attempt restored before any status arrived (the app restarts): only the attempt is known. */
/** How long a page that starts after an unconfirmed attempt's deadline still asks. */
const RESUME_MS = 10_000;
const NO_STATUS: UpdatesResponse = { app: { version: null }, reachable: false, updater: null, error: null };
const RELOAD_AFTER_MS = 1_500;
/** The systemd unit of a server set up as in docs/deployment.md (/srv/handbook). */
const PROJECT = "handbook";

type Translate = ReturnType<typeof useT<typeof messages.en>>;

/** The update icon in the header: admins only. */
export function UpdateButton() {
  return useIsAdmin() ? <AdminUpdateButton /> : null;
}

/** Renders again at `at` (Date.now() time), so what depends on the time shows without a new answer. */
function useRenderAt(at: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null || Number.isNaN(at)) return;
    const timer = window.setTimeout(() => setTick((tick) => tick + 1), Math.max(0, at - Date.now()));
    return () => window.clearTimeout(timer);
  }, [at]);
}

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
  // An unconfirmed attempt ends a minute after it started; a page that starts
  // later (a reload, back from sign-in) still asks the updater once first.
  const [shownAt] = useState(Date.now);
  const deadline =
    pending && !pending.confirmed ? Math.max(pending.startedAt + RECONCILE_MS, shownAt + RESUME_MS) : null;
  const queryClient = useQueryClient();
  const updates = useUpdates({ waitMs: pending ? POLL_WHILE_INSTALLING_MS : false, until: deadline });
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
  /** The installation an admin stopped waiting for. */
  const [ignored, setIgnored] = useState<IgnoredInstall | null>(null);
  /** The `last` of the newest status: the earlier result of the next attempt. */
  const newestLast = useRef<LastResult | null>(null);
  const reloadTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reloadTimer.current), []);

  const data = updates.data;
  const signedOutNow = signedOut(updates.error);
  // While the app restarts, failed requests and an unreachable updater are expected: keep asking.
  const restarting = Boolean(pending) && (updates.isError ? !signedOutNow : data?.reachable === false);

  useEffect(() => {
    // Each failed request after the start is an outage; a signed-out answer is none.
    const current = pendingRef.current;
    if (!current || !updates.isError || signedOutNow) return;
    const next = observe(current, { at: updates.errorUpdatedAt, error: errorMessage(updates.error) });
    if (next !== current) setPending(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new error counts
  }, [updates.errorUpdatedAt]);

  const follow = (next: PendingInstall) => {
    setFollowed(null);
    setPending(next);
  };

  useEffect(() => {
    if (!data) return;
    if (data.updater) newestLast.current = data.updater.last;
    if (done) return;
    const now = Date.now();
    const running = data.updater?.installing;
    const earlier = data.updater?.last ?? null;
    const current = pendingRef.current;
    if (current) {
      const seen = observe(current, { at: updates.dataUpdatedAt, response: data });
      const outcome = installOutcome(seen, data, updates.dataUpdatedAt);
      if (outcome.kind === "done") {
        setDone(current.version);
        setPending(null);
        toast.success(t("updated", { version: current.version }));
        reloadTimer.current = window.setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
      } else if (outcome.kind === "failed") {
        setPending(null);
        setFollowed(current.version);
        setOpen(true);
      } else if (running && running.version !== current.version) {
        // Another installation runs (another admin, an automatic one): follow that one.
        follow(adoptInstall(running, earlier, now));
      } else {
        const next = outcome.confirmed && !seen.confirmed ? { ...seen, confirmed: true, reason: null } : seen;
        if (next !== current) setPending(next);
      }
      return;
    }
    // An installation the updater runs (automatic, or another admin's) is followed too.
    if (running && !isIgnored(ignored, running)) follow(adoptInstall(running, earlier, now));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each answer and each new installation
  }, [data, updates.dataUpdatedAt, pending?.version, pending?.startedAt]);

  useEffect(() => {
    // An unconfirmed attempt ends 60 s after its start, whatever the polls return; signed out, it stays.
    if (deadline === null || signedOutNow) return;
    const attempt = pendingRef.current;
    const timer = window.setTimeout(
      () => {
        const current = pendingRef.current;
        if (!current || current.confirmed || current.startedAt !== attempt?.startedAt) return;
        const end = unconfirmedEnd(current);
        setPending(null);
        toast.error(t(end.message), { description: end.detail ?? undefined });
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per unconfirmed attempt
  }, [deadline, signedOutNow]);

  // "Stop waiting" shows after 15 minutes, also while no answer arrives.
  const running = data?.updater?.installing ?? null;
  const since = pending?.startedAt ?? (running ? Date.parse(running.startedAt) : NaN);
  useRenderAt(Number.isNaN(since) ? null : since + INSTALL_PATIENCE_MS);

  // An attempt restored while every request fails still shows (Restarting…, Stop waiting),
  // and so does a status that failed before any answer (no update service; a click checks).
  const shown = data ?? (pending || (updates.isError && !signedOutNow) ? NO_STATUS : null);
  if (!shown) return null;
  const state = buttonState(shown, { waiting: Boolean(pending || done), checking, followed });
  const hasPopover = POPOVER_STATES.has(state);
  const installingVersion = pending?.version ?? done ?? shown.updater?.installing?.version ?? "";
  const label = buttonLabel(t, state, shown, installingVersion, restarting, followed);
  const tooLong = waitedTooLong(since, Date.now());

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

  /** Asks the unreachable updater again; says why when it still does not answer. */
  const askAgain = async () => {
    const result = await updates.refetch();
    const error = result.error
      ? errorMessage(result.error)
      : result.data?.updater
        ? null
        : result.data?.error;
    if (error) toast.error(error);
  };

  const runInstall = async (version: string) => {
    // Remembered before the request, with the earlier result: an answer that never arrives may still have started it.
    const attempt = pendingInstall(version, Date.now(), newestLast.current);
    setOpen(false);
    follow(attempt);
    // The fast polls must not wait for a status request that started before (they would share it).
    if (queryClient.isFetching({ queryKey: updatesKey }) > 0) void updates.refetch();
    const reply = await install.mutateAsync(version);
    const current = pendingRef.current;
    // A status may have decided meanwhile (a result, another installation): that stands.
    if (current?.version !== attempt.version || current.startedAt !== attempt.startedAt) return;
    const next = afterInstallReply(current, reply, Date.now());
    setPending(next.pending);
    if (next.refused) toast.error(next.refused);
  };

  const stopWaiting = () => {
    // Ignored by the identity stored on the attempt, also while the updater does not answer.
    const current = pendingRef.current;
    if (current) setIgnored(ignoreInstall(current));
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
                  setOpen(false);
                  if (state === "current") void runCheck(true);
                  else if (state === "unreachable") void askAgain();
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
            data={shown}
            pending={pending}
            waiting={Boolean(pending || done)}
            tooLong={tooLong}
            followed={followed}
            installingVersion={installingVersion}
            restarting={restarting}
            appName={appName}
            onInstall={askInstall}
            onStopWaiting={stopWaiting}
          />
          <PopoverFooter data={shown} checking={checking} onCheck={() => void runCheck(false)} />
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

/** A failed installation that a newer offer replaced: "0.2.1 failed: <message>". */
function ReplacedFailure({ data }: { data: UpdatesResponse }) {
  const t = useT(messages);
  const failure = replacedFailure(data);
  if (!failure) return null;
  return (
    <p className="text-destructive break-words">
      {failure.message
        ? t("failedLine", { version: failure.version, message: failure.message })
        : t("failedTitle", { version: failure.version })}
    </p>
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
  /** This tab follows an installation (or reloads in a moment). */
  waiting: boolean;
  /** 15 minutes passed since the installation started. */
  tooLong: boolean;
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
    return (
      <>
        <PopoverHeader>
          <PopoverTitle>{t("installing", { version })}</PopoverTitle>
          <PopoverDescription role="status">{stageText}</PopoverDescription>
        </PopoverHeader>
        {props.waiting ? <p>{t("reloads", { app: props.appName })}</p> : null}
        {props.tooLong ? (
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
        <ReplacedFailure data={data} />
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
        <ReplacedFailure data={data} />
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
