import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  Copy,
  FileCode,
  FilePlus2,
  FileQuestion,
  FolderInput,
  GitPullRequestArrow,
  History,
  Info,
  MoreHorizontal,
  Pencil,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { Page } from "@handbook/shared/api/pages";
import type { Space } from "@handbook/shared/api/spaces";
import { BUILT_IN_KEYS, BUILT_IN_PROPERTIES, splitFrontmatter, type PageStatus } from "@handbook/shared/page";
import { pageMarkdownUrl, parentPath, resolveLink } from "@handbook/shared/paths";
import { ConfirmDialog } from "@meldgrove/ui/confirm-dialog";
import { Page as PageLayout } from "@/components/layout/page";
import { MarkdownView } from "@/components/markdown";
import { pageByPathQuery, spaceQuery } from "@/components/page/queries";
import { StatusBadge } from "@/components/page/status-badge";
import { EmptyState, ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Alert, AlertDescription } from "@meldgrove/ui/alert";
import { Badge } from "@meldgrove/ui/badge";
import { Button } from "@meldgrove/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meldgrove/ui/dropdown-menu";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useT } from "@/i18n";
import { messages } from "./messages";
import { MoveDialog } from "./move-dialog";

/** A page of a space, by path (old paths of moved pages redirect). */
export function PageView({ space, path }: { space: string; path: string }) {
  const t = useT(messages);
  const navigate = useNavigate();
  const query = useQuery(pageByPathQuery(space, path));
  const spaceData = useQuery(spaceQuery(space)).data;

  const actualPath = query.data?.path;
  useEffect(() => {
    // The page moved: show its current address.
    if (actualPath && actualPath !== path) {
      void navigate({
        to: "/s/$space/$",
        params: { space, _splat: actualPath },
        hash: window.location.hash.slice(1) || undefined,
        replace: true,
      });
    }
  }, [actualPath, path, space, navigate]);

  if (!query.data) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageLayout>
        {query.isPending ? (
          <LoadingState />
        ) : missing ? (
          <EmptyState
            icon={<FileQuestion />}
            title={t("notFound")}
            description={t("notFoundHint")}
            action={
              <Button variant="outline" asChild>
                <Link to="/s/$space" params={{ space }}>
                  {t("backToSpace")}
                </Link>
              </Button>
            }
          />
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </PageLayout>
    );
  }
  return <PageContent page={query.data} space={spaceData} />;
}

/** Scrolls to the heading of the URL's #anchor once the page is shown. */
function useScrollToAnchor(ready: boolean) {
  useEffect(() => {
    if (!ready || !window.location.hash) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, [ready]);
}

function Breadcrumbs({ page }: { page: Page }) {
  const t = useT(messages);
  return (
    <nav
      aria-label={t("pages")}
      className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-sm"
    >
      <Link to="/s/$space" params={{ space: page.space }} className="hover:text-foreground truncate">
        {page.spaceName}
      </Link>
      {page.breadcrumbs
        .filter((crumb) => crumb.id !== page.id)
        .map((crumb) => (
          <span key={crumb.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            <Link
              to="/s/$space/$"
              params={{ space: crumb.space, _splat: crumb.path }}
              className="hover:text-foreground truncate"
            >
              {crumb.title}
            </Link>
          </span>
        ))}
    </nav>
  );
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function formatValue(value: unknown, yes: string, no: string): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? yes : no;
  return String(value);
}

function PropertiesPanel({ page, space }: { page: Page; space: Space | undefined }) {
  const t = useT(messages);
  const format = useFormatter();
  const typeLabel = space?.pageTypes.find((pageType) => pageType.key === page.type)?.label ?? page.type;
  const replacedBy = typeof page.properties.replaced_by === "string" ? page.properties.replaced_by : null;
  const target = replacedBy ? resolveLink(replacedBy, { space: page.space, path: page.path }) : null;
  const custom = (space?.properties ?? []).filter((property) => page.properties[property.key] !== undefined);
  const builtIn = new Set<string>(BUILT_IN_KEYS);
  const others = Object.keys(page.properties).filter(
    (key) => !builtIn.has(key) && !space?.properties.some((property) => property.key === key),
  );
  const rows: ReactNode[] = [];
  if (page.type)
    rows.push(
      <PropertyRow key="type" label={t("type")}>
        {typeLabel}
      </PropertyRow>,
    );
  if (page.status !== "active") {
    rows.push(
      <PropertyRow key="status" label={t("status")}>
        <StatusBadge status={page.status as PageStatus} />
      </PropertyRow>,
    );
  }
  if (page.tags.length > 0) {
    rows.push(
      <PropertyRow key="tags" label={t("tags")}>
        <span className="flex flex-wrap gap-1">
          {page.tags.map((tag) => (
            <Badge key={tag} variant="secondary" asChild>
              <Link to="/tags/$tag" params={{ tag }}>
                {tag}
              </Link>
            </Badge>
          ))}
        </span>
      </PropertyRow>,
    );
  }
  if (typeof page.properties.owner === "string") {
    rows.push(
      <PropertyRow key="owner" label={t("owner")}>
        <a href={`mailto:${page.properties.owner}`} className="underline underline-offset-4">
          {page.properties.owner}
        </a>
      </PropertyRow>,
    );
  }
  if (typeof page.properties.reviewed === "string") {
    rows.push(
      <PropertyRow key="reviewed" label={t("reviewed")}>
        {format.date(page.properties.reviewed)}
      </PropertyRow>,
    );
  }
  if (replacedBy) {
    rows.push(
      <PropertyRow key="replaced_by" label={t("replacedByLabel")}>
        {target?.kind === "page" && target.path ? (
          <Link
            to="/s/$space/$"
            params={{ space: target.space, _splat: target.path }}
            className="underline underline-offset-4"
          >
            {replacedBy}
          </Link>
        ) : (
          replacedBy
        )}
      </PropertyRow>,
    );
  }
  for (const property of custom) {
    rows.push(
      <PropertyRow key={property.key} label={property.label}>
        {property.type === "url" && typeof page.properties[property.key] === "string" ? (
          <a
            href={String(page.properties[property.key])}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            {String(page.properties[property.key])}
          </a>
        ) : property.type === "date" && typeof page.properties[property.key] === "string" ? (
          format.date(String(page.properties[property.key]))
        ) : (
          formatValue(page.properties[property.key], t("yes"), t("no"))
        )}
      </PropertyRow>,
    );
  }
  for (const key of others) {
    rows.push(
      <PropertyRow
        key={key}
        label={BUILT_IN_PROPERTIES[key as keyof typeof BUILT_IN_PROPERTIES]?.label ?? key}
      >
        {formatValue(page.properties[key], t("yes"), t("no"))}
      </PropertyRow>,
    );
  }
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="page-properties" className="rounded-md border p-4">
      <h2 id="page-properties" className="mb-1 text-sm font-semibold">
        {t("properties")}
      </h2>
      <dl className="divide-y">{rows}</dl>
    </section>
  );
}

function PageContent({ page, space }: { page: Page; space: Space | undefined }) {
  const t = useT(messages);
  const format = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useScrollToAnchor(true);
  const body = splitFrontmatter(page.markdown)?.body ?? page.body;
  const replacedBy = typeof page.properties.replaced_by === "string" ? page.properties.replaced_by : null;
  const replacement = replacedBy ? resolveLink(replacedBy, { space: page.space, path: page.path }) : null;
  const abilities = page.abilities;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${page.space}/${page.path}`);
      toast.success(t("linkCopied"));
    } catch {
      toast.error(errorMessage(new Error("Copy failed")));
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/pages/${page.id}`);
      await queryClient.invalidateQueries({ queryKey: ["space", page.space] });
      queryClient.removeQueries({ queryKey: ["page", page.id] });
      toast.success(t("deleted"));
      const parent = parentPath(page.path);
      if (parent) void navigate({ to: "/s/$space/$", params: { space: page.space, _splat: parent } });
      else void navigate({ to: "/s/$space", params: { space: page.space } });
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  return (
    <PageLayout>
      <div className="flex flex-col gap-3">
        <Breadcrumbs page={page} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight break-words">{page.title}</h1>
            {page.description ? <p className="text-muted-foreground">{page.description}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {abilities.editLive ? (
              <Button asChild>
                <Link to="/pages/$id/edit" params={{ id: page.id }}>
                  <Pencil />
                  {t("edit")}
                </Link>
              </Button>
            ) : null}
            {abilities.propose ? (
              <Button variant={abilities.editLive ? "outline" : "default"} asChild>
                <Link to="/pages/$id/edit" params={{ id: page.id }} search={{ changeSet: "new" }}>
                  <GitPullRequestArrow />
                  {t("suggest")}
                </Link>
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("more")}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {abilities.editLive || abilities.propose ? (
                  <DropdownMenuItem asChild>
                    <Link
                      to="/s/$space/-/new"
                      params={{ space: page.space }}
                      search={{ parent: page.path, changeSet: abilities.editLive ? undefined : "new" }}
                    >
                      <FilePlus2 />
                      {t("newSubPage")}
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {abilities.editLive ? (
                  <DropdownMenuItem onSelect={() => setMoving(true)}>
                    <FolderInput />
                    {t("move")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link to="/pages/$id/history" params={{ id: page.id }}>
                    <History />
                    {t("history")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={pageMarkdownUrl(page.space, page.path)} target="_blank" rel="noopener noreferrer">
                    <FileCode />
                    {t("markdownFile")}
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copyLink()}>
                  <Copy />
                  {t("copyLink")}
                </DropdownMenuItem>
                {abilities.editLive ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                      <Trash2 />
                      {t("delete")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {page.status === "deprecated" ? (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            <span>
              {t("deprecated")}{" "}
              {replacement?.kind === "page" && replacement.path ? (
                <>
                  {t("seeInstead")}{" "}
                  <Link
                    to="/s/$space/$"
                    params={{ space: replacement.space, _splat: replacement.path }}
                    className="font-medium underline underline-offset-4"
                  >
                    {replacedBy}
                  </Link>
                </>
              ) : null}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {page.lock ? (
        <Alert>
          <Info />
          <AlertDescription>
            {page.lock.mine
              ? t("lockedMine")
              : t("lockedBy", { name: page.lock.user.name, time: format.relative(page.lock.since) })}
          </AlertDescription>
        </Alert>
      ) : null}
      {page.draft && abilities.editLive ? (
        <Alert>
          <Pencil />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{t("draftNotice", { time: format.relative(page.draft.updatedAt) })}</span>
            <Button size="sm" variant="outline" asChild>
              <Link to="/pages/$id/edit" params={{ id: page.id }}>
                {t("continueEditing")}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {page.changeSets.length > 0 ? (
        <Alert>
          <GitPullRequestArrow />
          <AlertDescription>
            <span className="font-medium">{t("pendingChanges")}: </span>
            {page.changeSets.map((changeSet, index) => (
              <span key={changeSet.number}>
                {index > 0 ? ", " : ""}
                <Link
                  to="/changes/$number"
                  params={{ number: String(changeSet.number) }}
                  className="underline underline-offset-4"
                >
                  #{changeSet.number} {changeSet.title}
                </Link>
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article className="min-w-0">
          <MarkdownView markdown={body} space={page.space} path={page.path} title={page.title} />
          <p className="text-muted-foreground mt-10 border-t pt-4 text-xs">
            {page.updatedBy
              ? t("lastChange", {
                  time: format.relative(page.updatedAt),
                  name: page.updatedBy.name,
                  revision: page.revision,
                })
              : t("lastChangeAnonymous", { time: format.relative(page.updatedAt), revision: page.revision })}
          </p>
        </article>
        <aside className="flex min-w-0 flex-col gap-4">
          <PropertiesPanel page={page} space={space} />
          {page.children.length > 0 ? (
            <section aria-labelledby="page-children" className="rounded-md border p-4">
              <h2 id="page-children" className="mb-2 text-sm font-semibold">
                {t("subPages")}
              </h2>
              <ul className="space-y-1 text-sm">
                {page.children.map((child) => (
                  <li key={child.id} className="flex items-center gap-2">
                    <Link
                      to="/s/$space/$"
                      params={{ space: child.space, _splat: child.path }}
                      className="truncate underline-offset-4 hover:underline"
                    >
                      {child.title}
                    </Link>
                    <StatusBadge status={child.status} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="page-backlinks" className="rounded-md border p-4">
            <h2 id="page-backlinks" className="mb-2 text-sm font-semibold">
              {t("backlinks")}
            </h2>
            {page.backlinks.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {page.backlinks.map((link) => (
                  <li key={link.id} className="truncate">
                    <Link
                      to="/s/$space/$"
                      params={{ space: link.space, _splat: link.path }}
                      className="underline-offset-4 hover:underline"
                    >
                      {link.title}
                    </Link>
                    {link.space !== page.space ? (
                      <span className="text-muted-foreground"> · {link.space}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">{t("noBacklinks")}</p>
            )}
          </section>
        </aside>
      </div>

      {moving ? (
        <MoveDialog
          page={page}
          open={moving}
          onOpenChange={setMoving}
          onMoved={(moved) =>
            void navigate({ to: "/s/$space/$", params: { space: page.space, _splat: moved.path } })
          }
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("deleteTitle", { title: page.title })}
        description={t("deleteText")}
        confirmLabel={t("delete")}
        destructive
        onConfirm={remove}
      />
    </PageLayout>
  );
}
