import { useState } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";
import type { SpaceSchema } from "@handbook/shared/page";
import { MarkdownView } from "@/components/markdown";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { defineMessages, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { bodyOf, valuesOf, withBody, withValues } from "./file";
import { MarkdownEditor } from "./markdown-editor";
import { PropertiesForm, propertyErrors } from "./properties-form";

const messages = defineMessages({
  en: {
    properties: "Properties",
    write: "Write",
    preview: "Preview",
    file: "Whole file",
    sideBySide: "Preview beside the text",
    body: "Page text in Markdown",
    source: "Whole page file: frontmatter and Markdown",
    yamlError: "The frontmatter cannot be read: {message}. Fix it in “Whole file”.",
    emptyPreview: "Nothing to show yet.",
  },
});

export type EditorWorkspaceProps = {
  /** The whole page file. */
  file: string;
  onChange: (file: string) => void;
  space: string;
  /** The page's path (or the planned path of a new page), for links in the preview. */
  path: string;
  schema: SpaceSchema;
  /** Field errors of the last save (`properties.<key>`, `markdown`). */
  fields?: Record<string, string>;
  onUpload?: (file: File) => Promise<string>;
  onActivity?: () => void;
  readOnly?: boolean;
  /** Start with the properties open (new pages). */
  propertiesOpen?: boolean;
};

/**
 * The page editor's work area: the properties as a form, the body in the
 * Markdown editor, a preview, and the whole file as text. All views edit
 * one file string.
 */
export function EditorWorkspace(props: EditorWorkspaceProps) {
  const t = useT(messages);
  const [tab, setTab] = useState("write");
  const [sideBySide, setSideBySide] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(props.propertiesOpen ?? true);
  const read = valuesOf(props.file);
  const values = "values" in read ? read.values : null;
  const body = bodyOf(props.file);
  const title = values && typeof values.title === "string" ? values.title : undefined;
  const errors = propertyErrors(props.fields);
  const hasPropertyErrors = Object.keys(errors).length > 0;

  const preview = (
    <div className="bg-background min-h-[24rem] min-w-0 rounded-md border p-4">
      {body.trim() ? (
        <MarkdownView markdown={body} space={props.space} path={props.path} title={title} />
      ) : (
        <p className="text-muted-foreground text-sm">{t("emptyPreview")}</p>
      )}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {props.fields?.markdown ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{props.fields.markdown}</AlertDescription>
        </Alert>
      ) : null}

      <Collapsible
        open={propertiesOpen || hasPropertyErrors}
        onOpenChange={setPropertiesOpen}
        className="rounded-md border"
      >
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="w-full justify-between rounded-b-none px-4">
            <span className="font-semibold">{t("properties")}</span>
            <ChevronDown
              className={cn("transition-transform", (propertiesOpen || hasPropertyErrors) && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t p-4">
          {values ? (
            <PropertiesForm
              values={values}
              schema={props.schema}
              errors={errors}
              disabled={props.readOnly}
              onChange={(next) => {
                props.onChange(withValues(props.file, next, props.schema));
                props.onActivity?.();
              }}
            />
          ) : (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>
                {t("yamlError", { message: "error" in read ? read.error : "" })}
              </AlertDescription>
            </Alert>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Tabs value={tab} onValueChange={setTab} className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="write">{t("write")}</TabsTrigger>
            <TabsTrigger value="preview" className={cn(sideBySide && "lg:hidden")}>
              {t("preview")}
            </TabsTrigger>
            <TabsTrigger value="file">{t("file")}</TabsTrigger>
          </TabsList>
          {tab === "write" ? (
            <div className="hidden items-center gap-2 lg:flex">
              <Switch id="editor-side-by-side" checked={sideBySide} onCheckedChange={setSideBySide} />
              <Label htmlFor="editor-side-by-side" className="text-sm font-normal">
                {t("sideBySide")}
              </Label>
            </div>
          ) : null}
        </div>
        <TabsContent value="write" className="mt-3">
          <div className={cn("grid min-w-0 gap-4", sideBySide && "lg:grid-cols-2")}>
            <MarkdownEditor
              value={body}
              onChange={(next) => props.onChange(withBody(props.file, next))}
              space={props.space}
              onUpload={props.onUpload}
              onActivity={props.onActivity}
              label={t("body")}
              readOnly={props.readOnly}
            />
            {sideBySide ? <div className="hidden min-w-0 lg:block">{preview}</div> : null}
          </div>
        </TabsContent>
        <TabsContent value="preview" className="mt-3">
          {preview}
        </TabsContent>
        <TabsContent value="file" className="mt-3">
          <MarkdownEditor
            value={props.file}
            onChange={props.onChange}
            space={props.space}
            onActivity={props.onActivity}
            label={t("source")}
            readOnly={props.readOnly}
            plain
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
