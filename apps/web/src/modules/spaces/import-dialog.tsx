import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { ImportResult } from "@knowledge/shared/api/spaces";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, apiUrl, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { messages } from "./messages";

async function upload(space: string, file: File, options: { defineProperties: boolean; title: string }) {
  const query: Record<string, string> = { defineProperties: String(options.defineProperties) };
  if (options.title) query.title = options.title;
  const body = new FormData();
  body.append("file", file);
  for (const [key, value] of Object.entries(query)) body.append(key, value);
  const response = await fetch(apiUrl(`/spaces/${encodeURIComponent(space)}/import`, query), {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    body,
  });
  const data = (await response.json().catch(() => null)) as
    | (ImportResult & { error?: undefined })
    | { error?: { code?: string; message?: string; fields?: Record<string, string> } }
    | null;
  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "internal_error",
      error?.message ?? "Import failed",
      error?.fields,
    );
  }
  return data as ImportResult;
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="text-muted-foreground max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm">
        {items.map((item) => (
          <li key={item} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Imports a zip of Markdown files as a change set. */
export function ImportDialog(props: {
  space: string;
  canDefine: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT(messages);
  const queryClient = useQueryClient();
  const fileId = useId();
  const titleId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [define, setDefine] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    try {
      const imported = await upload(props.space, file, {
        defineProperties: define && props.canDefine,
        title: title.trim(),
      });
      setResult(imported);
      await queryClient.invalidateQueries({ queryKey: ["space", props.space] });
      await queryClient.invalidateQueries({ queryKey: ["change-sets"] });
      toast.success(t("importDone"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !pending && props.onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("importTitle")}</DialogTitle>
          <DialogDescription>{t("importText")}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-4">
            <p className="text-sm">
              {t("importSummary", {
                created: result.created,
                updated: result.updated,
                unchanged: result.unchanged,
              })}
            </p>
            {result.changeSet ? (
              <Button asChild>
                <Link to="/changes/$number" params={{ number: String(result.changeSet.number) }}>
                  {t("openChangeSet", { number: result.changeSet.number })}
                </Link>
              </Button>
            ) : (
              <p className="text-muted-foreground text-sm">{t("nothingImported")}</p>
            )}
            <List title={t("skipped")} items={result.skipped.map((item) => `${item.file}: ${item.reason}`)} />
            <List title={t("dropped")} items={result.droppedProperties} />
            <List title={t("defined")} items={[...result.definedProperties, ...result.definedPageTypes]} />
            <List title={t("notes")} items={result.notes} />
            <DialogFooter>
              <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                {t("close")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <Field>
              <FieldLabel htmlFor={fileId}>{t("zipFile")}</FieldLabel>
              <Input
                id={fileId}
                type="file"
                accept=".zip,application/zip"
                required
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Field>
            {props.canDefine ? (
              <Field orientation="horizontal">
                <Checkbox
                  id={`${fileId}-define`}
                  checked={define}
                  onCheckedChange={(checked) => setDefine(checked === true)}
                />
                <div className="space-y-1">
                  <FieldLabel htmlFor={`${fileId}-define`}>{t("defineProperties")}</FieldLabel>
                  <FieldDescription>{t("defineHelp")}</FieldDescription>
                </div>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={titleId}>{t("changeSetTitle")}</FieldLabel>
              <Input
                id={titleId}
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => props.onOpenChange(false)}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={pending || !file}>
                {pending ? <Spinner /> : null}
                {pending ? t("importing") : t("startImport")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
