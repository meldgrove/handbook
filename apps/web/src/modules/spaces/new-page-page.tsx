import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import type { ChangeSet } from "@handbook/shared/api/changes";
import type { Page } from "@handbook/shared/api/pages";
import type { FileInfo, Space } from "@handbook/shared/api/spaces";
import { newPageFile } from "@handbook/shared/page";
import { joinPath, slugify } from "@handbook/shared/paths";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LazyEditorWorkspace as EditorWorkspace } from "@/components/editor/lazy-workspace";
import { bodyOf, valuesOf, withBody, withValues } from "@/components/editor/file";
import { Page as PageLayout, PageHeader } from "@/components/layout/page";
import { ChangeSetDialog, submitSuggestion } from "@/components/page/change-set-dialog";
import { changeSetQuery, spaceQuery, treeQuery } from "@/components/page/queries";
import { buildTree, flattenTree } from "@/components/page/tree";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { messages } from "./messages";

const TOP = "__top";
const NO_TYPE = "__none";

/** A new page, created live (editors) or suggested in a change set. */
export function NewPagePage(props: { space: string; parent?: string; changeSet?: number | "new" }) {
  const space = useQuery(spaceQuery(props.space));
  const tree = useQuery(treeQuery(props.space));
  const changeSet = useQuery({
    ...changeSetQuery(typeof props.changeSet === "number" ? props.changeSet : 0),
    enabled: typeof props.changeSet === "number",
  });
  const error = space.error ?? tree.error ?? changeSet.error;
  if (error) {
    return (
      <PageLayout>
        <ErrorState error={error} />
      </PageLayout>
    );
  }
  if (!space.data || !tree.data || (typeof props.changeSet === "number" && !changeSet.data)) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  // Readers can only suggest.
  const target = props.changeSet ?? (space.data.abilities.editLive ? undefined : "new");
  return (
    <NewPageForm
      space={space.data}
      pages={flattenTree(buildTree(tree.data.items))}
      parent={props.parent}
      changeSet={target}
      changeSetTitle={changeSet.data?.title ?? null}
    />
  );
}

function NewPageForm(props: {
  space: Space;
  pages: { page: { id: string; path: string; title: string }; depth: number }[];
  parent?: string;
  changeSet: number | "new" | undefined;
  changeSetTitle: string | null;
}) {
  const t = useT(messages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const parentId = useId();
  const slugId = useId();
  const typeId = useId();
  const schema = { properties: props.space.properties, pageTypes: props.space.pageTypes };
  const initial = newPageFile({ title: "" }, schema);
  const [file, setFile] = useState(initial);
  const [parent, setParent] = useState(
    props.parent && props.pages.some((item) => item.page.path === props.parent) ? props.parent : TOP,
  );
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [fields, setFields] = useState<Record<string, string> | undefined>();
  const [saving, setSaving] = useState(false);
  const [askChangeSet, setAskChangeSet] = useState(false);
  const [changeSetErrors, setChangeSetErrors] = useState<Record<string, string> | undefined>();
  const [createdNumber, setCreatedNumber] = useState<number | null>(
    typeof props.changeSet === "number" ? props.changeSet : null,
  );
  const allowLeave = useRef(false);
  // A change set made by this page's dialog: submitted for review once the page is in it.
  const submitAfterSave = useRef(false);

  const suggesting = props.changeSet !== undefined;
  const read = valuesOf(file);
  const values = "values" in read ? read.values : {};
  const title = typeof values.title === "string" ? values.title : "";
  const type = typeof values.type === "string" ? values.type : null;
  const effectiveSlug = slugEdited ? slug : title.trim() ? slugify(title) : "";
  const parentPath = parent === TOP ? null : parent;
  const path = effectiveSlug ? joinPath(parentPath, effectiveSlug) : (parentPath ?? "");
  const dirty = file !== initial;

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => !allowLeave.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => !allowLeave.current && dirty,
    disabled: !dirty,
    withResolver: true,
  });

  const chooseType = (key: string | null) => {
    const previous = props.space.pageTypes.find((pageType) => pageType.key === type)?.template ?? "";
    const next = props.space.pageTypes.find((pageType) => pageType.key === key)?.template ?? "";
    let updated = withValues(file, { ...values, type: key }, schema);
    // Only replace the text while it is empty or still the previous template.
    const body = bodyOf(updated);
    if (body.trim() === "" || body.trim() === previous.trim()) updated = withBody(updated, next);
    setFile(updated);
  };

  const upload = async (picked: File) =>
    (await api.upload<FileInfo>(`/spaces/${encodeURIComponent(props.space.slug)}/files`, picked)).markdown;

  const done = (to: { page?: Page; number?: number }) => {
    allowLeave.current = true;
    if (to.number) void navigate({ to: "/changes/$number", params: { number: String(to.number) } });
    else if (to.page)
      void navigate({ to: "/s/$space/$", params: { space: to.page.space, _splat: to.page.path } });
  };

  const createLive = async () => {
    setSaving(true);
    setFields(undefined);
    try {
      const page = await api.post<Page>(`/spaces/${encodeURIComponent(props.space.slug)}/pages`, {
        parentPath,
        slug: effectiveSlug || undefined,
        markdown: file,
      });
      await queryClient.invalidateQueries({ queryKey: ["space", props.space.slug] });
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
      await queryClient.invalidateQueries({ queryKey: ["recent"] });
      toast.success(t("created"));
      done({ page });
    } catch (error) {
      if (error instanceof ApiError && error.fields) setFields(error.fields);
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const putInChangeSet = async (number: number) => {
    setSaving(true);
    setFields(undefined);
    try {
      await api.put<unknown>(`/change-sets/${number}/pages`, { path, markdown: file });
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
      toast.success(t(sent ? "suggestionSent" : "suggestionSaved", { number }));
      done({ number });
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
      const created = await api.post<ChangeSet>("/change-sets", { space: props.space.slug, ...value });
      submitAfterSave.current = true;
      setCreatedNumber(created.number);
      setAskChangeSet(false);
      setSaving(false);
      await putInChangeSet(created.number);
    } catch (error) {
      if (error instanceof ApiError && error.fields) setChangeSetErrors(error.fields);
      toast.error(errorMessage(error));
      setSaving(false);
    }
  };

  const save = () => {
    if (!title.trim()) {
      setFields({ "properties.title": t("titleFirst") });
      return;
    }
    if (!suggesting) return void createLive();
    if (createdNumber) return void putInChangeSet(createdNumber);
    setAskChangeSet(true);
  };

  const locationError = fields?.path ?? fields?.parentPath;
  return (
    <PageLayout wide>
      <div className="space-y-2">
        <Button variant="link" className="h-auto px-0 text-sm" asChild>
          <Link to="/s/$space" params={{ space: props.space.slug }}>
            <ArrowLeft />
            {props.space.name}
          </Link>
        </Button>
        <PageHeader
          title={
            suggesting
              ? t("suggestPageTitle", { space: props.space.name })
              : t("newPageTitle", { space: props.space.name })
          }
          description={
            createdNumber && props.changeSetTitle ? `#${createdNumber} ${props.changeSetTitle}` : undefined
          }
          actions={
            <>
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => void navigate({ to: "/s/$space", params: { space: props.space.slug } })}
              >
                {t("cancel")}
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? <Spinner /> : null}
                {suggesting ? t("saveSuggestion") : t("create")}
              </Button>
            </>
          }
        />
      </div>

      <section aria-labelledby="new-page-location" className="rounded-md border p-4">
        <h2 id="new-page-location" className="mb-3 font-semibold">
          {t("location")}
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field data-invalid={Boolean(locationError)}>
            <FieldLabel htmlFor={parentId}>{t("parent")}</FieldLabel>
            <Select value={parent} onValueChange={setParent}>
              <SelectTrigger id={parentId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TOP}>{t("topLevel")}</SelectItem>
                {props.pages.map((item) => (
                  <SelectItem key={item.page.id} value={item.page.path}>
                    <span style={{ paddingLeft: `${item.depth * 0.75}rem` }}>{item.page.title}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {locationError ? <FieldError>{locationError}</FieldError> : null}
          </Field>
          <Field data-invalid={Boolean(fields?.slug)}>
            <FieldLabel htmlFor={slugId}>{t("slug")}</FieldLabel>
            <Input
              id={slugId}
              value={effectiveSlug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
              }}
            />
            <FieldDescription>
              {path ? t("address", { url: `/s/${props.space.slug}/${path}` }) : t("slugHelp")}
            </FieldDescription>
            {fields?.slug ? <FieldError>{fields.slug}</FieldError> : null}
          </Field>
          {props.space.pageTypes.length > 0 ? (
            <Field>
              <FieldLabel htmlFor={typeId}>{t("pageType")}</FieldLabel>
              <Select
                value={type ?? NO_TYPE}
                onValueChange={(value) => chooseType(value === NO_TYPE ? null : value)}
              >
                <SelectTrigger id={typeId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TYPE}>{t("noType")}</SelectItem>
                  {props.space.pageTypes.map((pageType) => (
                    <SelectItem key={pageType.key} value={pageType.key}>
                      {pageType.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>
      </section>

      <EditorWorkspace
        file={file}
        onChange={setFile}
        space={props.space.slug}
        path={path || "new-page"}
        schema={schema}
        fields={fields}
        onUpload={upload}
      />

      {askChangeSet ? (
        <ChangeSetDialog
          open={askChangeSet}
          onOpenChange={setAskChangeSet}
          defaultTitle={title ? t("suggestNewTitle", { title }) : undefined}
          pending={saving}
          errors={changeSetErrors}
          onSubmit={(value) => void createChangeSet(value)}
        />
      ) : null}
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title={t("leaveTitle")}
        description={t("leaveText")}
        confirmLabel={t("leave")}
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </PageLayout>
  );
}
