import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, GitMerge, Lock, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { ChangeSet } from "@handbook/shared/api/changes";
import type { Draft, Page } from "@handbook/shared/api/pages";
import type { FileInfo, Space } from "@handbook/shared/api/spaces";
import { hasConflictMarkers } from "@handbook/shared/merge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { readPageConflict, saveBlocker, type PageConflict } from "@/components/editor/conflict";
import { LazyEditorWorkspace as EditorWorkspace } from "@/components/editor/lazy-workspace";
import { lockToken, readLockHolder } from "@/components/editor/lock";
import { apiErrorOf, rawRequest } from "@/components/editor/raw-api";
import { useEditLock } from "@/components/editor/use-edit-lock";
import { discardDraft, useDraftAutosave } from "@/components/editor/use-draft";
import { Page as PageLayout } from "@/components/layout/page";
import { ChangeSetDialog, submitSuggestion } from "@/components/page/change-set-dialog";
import { changeSetPageQuery, changeSetQuery, pageQuery, spaceQuery } from "@/components/page/queries";
import { ErrorState, LoadingState } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useT } from "@/i18n";
import { messages } from "./messages";

export type ChangeSetParam = number | "new" | undefined;

type EditorInit = {
  pageId: string;
  space: Space;
  path: string;
  title: string;
  file: string;
  baseRevision: number;
  mode: "live" | "changeSet";
  /** The change set to save into; null: create one on save. */
  changeSetNumber: number | null;
  changeSetTitle: string | null;
  draft: Page["draft"];
};

/**
 * The page editor. Live: with the edit lock, drafts and conflict merging.
 * With `changeSet`: saves into a change set (a suggestion), no lock.
 */
export function EditPage({ pageId, changeSet }: { pageId: string; changeSet: ChangeSetParam }) {
  const navigate = useNavigate();
  const number = typeof changeSet === "number" ? changeSet : null;
  const changeSetData = useQuery({ ...changeSetQuery(number ?? 0), enabled: number !== null });
  const item = useQuery({
    ...changeSetPageQuery(number ?? 0, pageId),
    enabled: number !== null,
    retry: false,
  });
  const itemMissing = item.error instanceof ApiError && item.error.status === 404;
  const needLive = number === null || itemMissing;
  const live = useQuery({ ...pageQuery(pageId), enabled: needLive, staleTime: Infinity });
  const spaceSlug = live.data?.space ?? changeSetData.data?.space.slug;
  const space = useQuery({ ...spaceQuery(spaceSlug ?? ""), enabled: Boolean(spaceSlug) });

  // Readers who open the live editor suggest instead.
  const mustSuggest = changeSet === undefined && live.data !== undefined && !live.data.abilities.editLive;
  useEffect(() => {
    if (mustSuggest) {
      void navigate({
        to: "/pages/$id/edit",
        params: { id: pageId },
        search: { changeSet: "new" },
        replace: true,
      });
    }
  }, [mustSuggest, navigate, pageId]);

  const error =
    (needLive ? live.error : null) ??
    (number !== null ? changeSetData.error : null) ??
    (number !== null && !itemMissing ? item.error : null) ??
    space.error;
  if (error) {
    return (
      <PageLayout>
        <ErrorState error={error} />
      </PageLayout>
    );
  }

  let init: EditorInit | null = null;
  if (space.data && !mustSuggest) {
    if (number !== null && item.data && changeSetData.data) {
      init = {
        pageId,
        space: space.data,
        path: item.data.item.path,
        title: item.data.item.title,
        file: item.data.proposed ?? item.data.live ?? "",
        baseRevision: item.data.item.baseRevision ?? 0,
        mode: "changeSet",
        changeSetNumber: number,
        changeSetTitle: changeSetData.data.title,
        draft: null,
      };
    } else if (live.data && (number === null || (itemMissing && changeSetData.data))) {
      init = {
        pageId,
        space: space.data,
        path: live.data.path,
        title: live.data.title,
        file: live.data.markdown,
        baseRevision: live.data.revision,
        mode: changeSet === undefined ? "live" : "changeSet",
        changeSetNumber: number,
        changeSetTitle: changeSetData.data?.title ?? null,
        draft: changeSet === undefined ? live.data.draft : null,
      };
    }
  }
  if (!init) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  return <Editor key={`${pageId}-${String(changeSet)}`} init={init} />;
}

function Editor({ init }: { init: EditorInit }) {
  const t = useT(messages);
  const format = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [file, setFile] = useState(init.file);
  const [savedFile, setSavedFile] = useState(init.file);
  const [baseRevision, setBaseRevision] = useState(init.baseRevision);
  const [conflict, setConflict] = useState<PageConflict | null>(null);
  const [fields, setFields] = useState<Record<string, string> | undefined>();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [draftOpen, setDraftOpen] = useState(Boolean(init.draft));
  const [askChangeSet, setAskChangeSet] = useState(false);
  const [changeSetErrors, setChangeSetErrors] = useState<Record<string, string> | undefined>();
  const [createdNumber, setCreatedNumber] = useState<number | null>(init.changeSetNumber);
  // "Save as suggestion" after losing the lock turns the live editor into a suggestion.
  const [suggesting, setSuggesting] = useState(init.mode === "changeSet");
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const allowLeave = useRef(false);
  // A change set made by this editor's dialog: submitted for review once the change is in it.
  const submitAfterSave = useRef(false);

  const live = init.mode === "live";
  const lock = useEditLock(init.pageId, live);
  const lockStatus = lock.state.status;
  const dirty = file !== savedFile;
  const spaceSlug = init.space.slug;
  const schema = { properties: init.space.properties, pageTypes: init.space.pageTypes };

  useDraftAutosave({
    pageId: init.pageId,
    file,
    baseRevision,
    savedFile,
    enabled: live && (lockStatus === "held" || lockStatus === "expired" || lockStatus === "lost"),
  });

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => !allowLeave.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => !allowLeave.current && dirty,
    disabled: !dirty,
    withResolver: true,
  });

  const upload = async (picked: File) => {
    const info = await api.upload<FileInfo>(`/spaces/${encodeURIComponent(spaceSlug)}/files`, picked);
    return info.markdown;
  };

  const leaveTo = (to: { pathname: "page" | "changeSet"; number?: number; path?: string }) => {
    allowLeave.current = true;
    if (to.pathname === "changeSet" && to.number) {
      void navigate({ to: "/changes/$number", params: { number: String(to.number) } });
    } else {
      void navigate({ to: "/s/$space/$", params: { space: spaceSlug, _splat: to.path ?? init.path } });
    }
  };

  const invalidate = async (page?: Page) => {
    if (page) queryClient.setQueryData(pageQuery(init.pageId).queryKey, page);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["page-by-path", spaceSlug] }),
      queryClient.invalidateQueries({ queryKey: ["space", spaceSlug] }),
      queryClient.invalidateQueries({ queryKey: ["recent"] }),
      queryClient.invalidateQueries({ queryKey: ["page", init.pageId] }),
    ]);
  };

  const saveLive = async () => {
    if (saveBlocker(file)) {
      toast.error(t("conflictMarkersLeft"));
      return;
    }
    setSaving(true);
    setFields(undefined);
    try {
      const response = await rawRequest("PUT", `/pages/${init.pageId}`, {
        body: {
          markdown: file,
          baseRevision,
          lockToken: lockToken(lock.state) ?? undefined,
          message: note.trim() || undefined,
        },
      });
      if (response.ok) {
        const page = response.body as Page;
        lock.forget();
        setSavedFile(file);
        void discardDraft(init.pageId);
        await invalidate(page);
        toast.success(page.revision > baseRevision + 1 ? t("mergedSaved") : t("saved"));
        leaveTo({ pathname: "page", path: page.path });
        return;
      }
      const conflictBody = response.status === 409 ? readPageConflict(response.body) : null;
      if (conflictBody) {
        setFile(conflictBody.merged);
        setBaseRevision(conflictBody.currentRevision);
        setConflict(conflictBody);
        toast.warning(t("conflictTitle"));
        return;
      }
      // Someone else opened the editor while this one's lock had ended.
      const holder = response.status === 423 ? readLockHolder(response.body) : null;
      if (holder && !holder.mine) lock.lostTo(holder.user.name);
      const error = apiErrorOf(response);
      if (error.fields) setFields(error.fields);
      toast.error(error.message);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const saveToChangeSet = async (number: number) => {
    setSaving(true);
    setFields(undefined);
    try {
      // The revision the text was written from: changes saved live meanwhile are merged, not undone.
      await api.put<unknown>(`/change-sets/${number}/pages`, {
        pageId: init.pageId,
        markdown: file,
        baseRevision: baseRevision > 0 ? baseRevision : undefined,
      });
      setSavedFile(file);
      let sent = false;
      if (submitAfterSave.current) {
        sent = await submitSuggestion(number).then(
          () => true,
          (error: unknown) => {
            toast.error(errorMessage(error));
            return false;
          },
        );
        submitAfterSave.current = false;
      }
      await queryClient.invalidateQueries({ queryKey: ["change-set", number] });
      await queryClient.invalidateQueries({ queryKey: ["change-sets"] });
      await queryClient.invalidateQueries({ queryKey: ["page", init.pageId] });
      toast.success(t(sent ? "suggestionSent" : "suggestionSaved", { number }));
      leaveTo({ pathname: "changeSet", number });
    } catch (error) {
      if (error instanceof ApiError && error.fields) setFields(error.fields);
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const createChangeSet = async (value: { title: string; description: string }) => {
    setSaving(true);
    setChangeSetErrors(undefined);
    try {
      const created = await api.post<ChangeSet>("/change-sets", { space: spaceSlug, ...value });
      submitAfterSave.current = true;
      setCreatedNumber(created.number);
      setAskChangeSet(false);
      setSaving(false);
      await saveToChangeSet(created.number);
    } catch (error) {
      if (error instanceof ApiError && error.fields) setChangeSetErrors(error.fields);
      toast.error(errorMessage(error));
      setSaving(false);
    }
  };

  const save = () => {
    if (!suggesting) return void saveLive();
    if (createdNumber) return void saveToChangeSet(createdNumber);
    setAskChangeSet(true);
  };

  // Leaving unmounts the editor, which releases the lock; unsaved text asks first.
  const cancel = () => void navigate({ to: "/s/$space/$", params: { space: spaceSlug, _splat: init.path } });

  const restoreDraft = async () => {
    try {
      const draft = await api.get<Draft>(`/pages/${init.pageId}/draft`);
      setFile(draft.markdown);
      setBaseRevision(draft.baseRevision);
      setDraftOpen(false);
      toast.success(t("draftRestored"));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(file);
      toast.success(t("textCopied"));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const heading = suggesting
    ? t("suggestTitle", { title: init.title })
    : t("editTitle", { title: init.title });
  const lockBlocks =
    live && !suggesting && (lockStatus === "locked" || lockStatus === "acquiring" || lockStatus === "failed");
  // An expired lock still saves when nobody else took the page meanwhile (the server checks).
  const canSaveLive = lockStatus === "held" || lockStatus === "expired";
  const saveDisabled = saving || (!suggesting && !canSaveLive) || !dirty;

  return (
    <PageLayout wide>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <Button variant="link" className="h-auto px-0 text-sm" asChild>
            <Link to="/s/$space/$" params={{ space: spaceSlug, _splat: init.path }}>
              <ArrowLeft />
              {t("backToPage")}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight break-words">{heading}</h1>
          {suggesting && createdNumber ? (
            <p className="text-muted-foreground text-sm">
              <Link
                to="/changes/$number"
                params={{ number: String(createdNumber) }}
                className="underline underline-offset-4"
              >
                {t("changeSetLabel", { number: createdNumber, title: init.changeSetTitle ?? "" })}
              </Link>
            </p>
          ) : null}
        </div>
        {lockBlocks ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={cancel} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saveDisabled}>
              {saving ? <Spinner /> : null}
              {suggesting ? t("saveSuggestion") : t("save")}
            </Button>
          </div>
        )}
      </div>

      {live && !suggesting && lockStatus === "acquiring" ? <LoadingState label={t("acquiring")} /> : null}
      {live && !suggesting && lockStatus === "failed" && lock.state.status === "failed" ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{t("lockFailed", { message: lock.state.message })}</span>
            <Button size="sm" variant="outline" onClick={lock.retry}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {live && !suggesting && lock.state.status === "locked" ? (
        <Alert>
          <Lock />
          <AlertTitle>{t("lockedTitle")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>
              {lock.state.holder.mine
                ? t("lockedMineText")
                : t("lockedText", {
                    name: lock.state.holder.user.name,
                    time: format.relative(lock.state.holder.since),
                  })}
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  lock.state.status === "locked" && lock.state.holder.mine
                    ? void lock.takeOver()
                    : setConfirmTakeover(true)
                }
              >
                {lock.state.holder.mine ? t("editHere") : t("takeOver")}
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link to="/pages/$id/edit" params={{ id: init.pageId }} search={{ changeSet: "new" }}>
                  {t("suggestInstead")}
                </Link>
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to="/s/$space/$" params={{ space: spaceSlug, _splat: init.path }}>
                  {t("backToPage")}
                </Link>
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {live && !suggesting && lock.state.status === "expired" ? (
        <Alert>
          <Lock />
          <AlertTitle>{t("expiredTitle")}</AlertTitle>
          <AlertDescription>{t("expiredText")}</AlertDescription>
        </Alert>
      ) : null}
      {live && !suggesting && lock.state.status === "lost" ? (
        <Alert variant="destructive">
          <Lock />
          <AlertTitle>{t("lostTitle")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>{lock.state.by ? t("lostText", { name: lock.state.by }) : t("lostTextUnknown")}</span>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void copyText()}>
                {t("copyText")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setSuggesting(true);
                  setAskChangeSet(true);
                }}
              >
                {t("saveAsSuggestion")}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {live && draftOpen && init.draft && !lockBlocks ? (
        <Alert>
          <Pencil />
          <AlertTitle>{t("draftTitle")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>
              {t("draftText", {
                time: format.relative(init.draft.updatedAt),
                revision: init.draft.baseRevision,
              })}
            </span>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void restoreDraft()}>
                {t("restoreDraft")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void discardDraft(init.pageId);
                  setDraftOpen(false);
                }}
              >
                {t("discardDraft")}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {conflict ? (
        <Alert variant={hasConflictMarkers(file) ? "destructive" : "default"}>
          <GitMerge />
          <AlertTitle>{t("conflictTitle")}</AlertTitle>
          <AlertDescription>
            {hasConflictMarkers(file)
              ? t("conflictText", { name: conflict.updatedBy ?? t("conflictSomeone") })
              : t("conflictResolved")}
          </AlertDescription>
        </Alert>
      ) : null}

      {lockBlocks ? null : (
        <>
          <EditorWorkspace
            file={file}
            onChange={setFile}
            space={spaceSlug}
            path={init.path}
            schema={schema}
            fields={fields}
            onUpload={upload}
            onActivity={lock.markActivity}
            propertiesOpen={false}
          />
          {!suggesting ? (
            <div className="max-w-xl">
              <label htmlFor="edit-note" className="text-sm font-medium">
                {t("note")}
              </label>
              <Input
                id="edit-note"
                value={note}
                maxLength={300}
                placeholder={t("notePlaceholder")}
                onChange={(event) => setNote(event.target.value)}
                className="mt-1"
              />
            </div>
          ) : null}
        </>
      )}

      {askChangeSet ? (
        <ChangeSetDialog
          open={askChangeSet}
          onOpenChange={setAskChangeSet}
          pending={saving}
          errors={changeSetErrors}
          onSubmit={(value) => void createChangeSet(value)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmTakeover}
        onOpenChange={setConfirmTakeover}
        title={t("takeOverTitle")}
        description={
          lock.state.status === "locked"
            ? t("takeOverText", { name: lock.state.holder.user.name })
            : undefined
        }
        confirmLabel={t("takeOver")}
        onConfirm={() => lock.takeOver()}
      />
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title={t("leaveTitle")}
        description={live && !suggesting ? t("leaveText") : t("leaveTextSuggestion")}
        confirmLabel={t("leave")}
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </PageLayout>
  );
}
