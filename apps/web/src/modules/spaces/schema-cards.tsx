import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { toast } from "sonner";
import type { Space } from "@handbook/shared/api/spaces";
import { PROPERTY_TYPES, type PropertyType } from "@handbook/shared/page";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@meldgrove/ui/field";
import { Input } from "@meldgrove/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meldgrove/ui/select";
import { Spinner } from "@meldgrove/ui/spinner";
import { Switch } from "@meldgrove/ui/switch";
import { Textarea } from "@meldgrove/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { messages } from "./messages";
import {
  emptyPageTypeRow,
  emptyPropertyRow,
  hasOptions,
  keyFromLabel,
  moved,
  pageTypeDefinitions,
  pageTypeRows,
  propertyDefinitions,
  propertyRows,
  rowErrors,
  type PageTypeRow,
  type PropertyRow,
} from "./schema-edit";

const TYPE_LABELS: Record<PropertyType, string> = {
  text: "typeText",
  list: "typeList",
  number: "typeNumber",
  boolean: "typeBoolean",
  date: "typeDate",
  select: "typeSelect",
  multiselect: "typeMultiselect",
  url: "typeUrl",
  person: "typePerson",
};

function useSaveSpace(space: Space) {
  const t = useT(messages);
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<Record<string, string> | undefined>();
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<Space>(`/spaces/${encodeURIComponent(space.slug)}`, body),
    onMutate: () => setFields(undefined),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["space", space.slug], updated);
      await queryClient.invalidateQueries({ queryKey: ["space", space.slug] });
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
      toast.success(t("saved"));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fields) setFields(error.fields);
      toast.error(errorMessage(error));
    },
  });
  return { mutation, fields };
}

function RowButtons(props: {
  index: number;
  count: number;
  label: string;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT(messages);
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("moveUp")}
        disabled={props.index === 0}
        onClick={() => props.onMove(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("moveDown")}
        disabled={props.index === props.count - 1}
        onClick={() => props.onMove(1)}
      >
        <ArrowDown />
      </Button>
      <Button type="button" variant="ghost" size="icon" aria-label={props.label} onClick={props.onRemove}>
        <X />
      </Button>
    </div>
  );
}

/** The space's custom properties: key, label, type, options, required, help. */
export function PropertiesCard({ space }: { space: Space }) {
  const t = useT(messages);
  const [rows, setRows] = useState<PropertyRow[]>(() => propertyRows(space.properties));
  const { mutation, fields } = useSaveSpace(space);
  const errors = rowErrors(fields, "properties");
  const update = (index: number, change: Partial<PropertyRow>) =>
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...change } : row)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("properties")}</CardTitle>
        <CardDescription>{t("propertiesHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? <p className="text-muted-foreground text-sm">{t("noProperties")}</p> : null}
        {rows.map((row, index) => {
          const error = errors[index] ?? {};
          return (
            <fieldset key={row.id} className="space-y-3 rounded-md border p-3">
              <legend className="sr-only">{row.label || row.key || t("addProperty")}</legend>
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-3">
                  <Field data-invalid={Boolean(error.label)}>
                    <FieldLabel htmlFor={`${row.id}-label`}>{t("label")}</FieldLabel>
                    <Input
                      id={`${row.id}-label`}
                      value={row.label}
                      onChange={(event) => {
                        const label = event.target.value;
                        const autoKey = !row.key || row.key === keyFromLabel(row.label, "_");
                        update(index, { label, ...(autoKey ? { key: keyFromLabel(label, "_") } : {}) });
                      }}
                    />
                    {error.label ? <FieldError>{error.label}</FieldError> : null}
                  </Field>
                  <Field data-invalid={Boolean(error.key)}>
                    <FieldLabel htmlFor={`${row.id}-key`}>{t("key")}</FieldLabel>
                    <Input
                      id={`${row.id}-key`}
                      value={row.key}
                      className="font-mono"
                      onChange={(event) => update(index, { key: event.target.value })}
                    />
                    {error.key ? <FieldError>{error.key}</FieldError> : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${row.id}-type`}>{t("type")}</FieldLabel>
                    <Select
                      value={row.type}
                      onValueChange={(value) => update(index, { type: value as PropertyType })}
                    >
                      <SelectTrigger id={`${row.id}-type`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROPERTY_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(TYPE_LABELS[type] as "typeText")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <RowButtons
                  index={index}
                  count={rows.length}
                  label={t("removeProperty", { key: row.key || row.label })}
                  onMove={(direction) => setRows((current) => moved(current, index, direction))}
                  onRemove={() => setRows((current) => current.filter((_, position) => position !== index))}
                />
              </div>
              {hasOptions(row.type) ? (
                <Field data-invalid={Boolean(error.options)}>
                  <FieldLabel htmlFor={`${row.id}-options`}>{t("options")}</FieldLabel>
                  <Input
                    id={`${row.id}-options`}
                    value={row.optionsText}
                    onChange={(event) => update(index, { optionsText: event.target.value })}
                  />
                  <FieldDescription>{t("optionsHelp")}</FieldDescription>
                  {error.options ? <FieldError>{error.options}</FieldError> : null}
                </Field>
              ) : null}
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <Field>
                  <FieldLabel htmlFor={`${row.id}-help`}>{t("help")}</FieldLabel>
                  <Input
                    id={`${row.id}-help`}
                    value={row.help}
                    onChange={(event) => update(index, { help: event.target.value })}
                  />
                </Field>
                <div className="flex h-9 items-center gap-2">
                  <Switch
                    id={`${row.id}-required`}
                    checked={row.required}
                    onCheckedChange={(checked) => update(index, { required: checked })}
                  />
                  <label htmlFor={`${row.id}-required`} className="text-sm">
                    {t("required")}
                  </label>
                </div>
              </div>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="outline"
          onClick={() => setRows((current) => [...current, emptyPropertyRow()])}
        >
          <Plus />
          {t("addProperty")}
        </Button>
        {fields?.properties ? <FieldError>{fields.properties}</FieldError> : null}
      </CardContent>
      <CardFooter>
        <Button
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ properties: propertyDefinitions(rows) })}
        >
          {mutation.isPending ? <Spinner /> : null}
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The space's page types: key, label, template, required properties. */
export function PageTypesCard({ space }: { space: Space }) {
  const t = useT(messages);
  const [rows, setRows] = useState<PageTypeRow[]>(() => pageTypeRows(space.pageTypes));
  const { mutation, fields } = useSaveSpace(space);
  const errors = rowErrors(fields, "pageTypes");
  const update = (index: number, change: Partial<PageTypeRow>) =>
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...change } : row)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pageTypes")}</CardTitle>
        <CardDescription>{t("pageTypesHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? <p className="text-muted-foreground text-sm">{t("noPageTypes")}</p> : null}
        {rows.map((row, index) => {
          const error = errors[index] ?? {};
          return (
            <fieldset key={row.id} className="space-y-3 rounded-md border p-3">
              <legend className="sr-only">{row.label || row.key || t("addPageType")}</legend>
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-2">
                  <Field data-invalid={Boolean(error.label)}>
                    <FieldLabel htmlFor={`${row.id}-label`}>{t("label")}</FieldLabel>
                    <Input
                      id={`${row.id}-label`}
                      value={row.label}
                      onChange={(event) => {
                        const label = event.target.value;
                        const autoKey = !row.key || row.key === keyFromLabel(row.label, "-");
                        update(index, { label, ...(autoKey ? { key: keyFromLabel(label, "-") } : {}) });
                      }}
                    />
                    {error.label ? <FieldError>{error.label}</FieldError> : null}
                  </Field>
                  <Field data-invalid={Boolean(error.key)}>
                    <FieldLabel htmlFor={`${row.id}-key`}>{t("key")}</FieldLabel>
                    <Input
                      id={`${row.id}-key`}
                      value={row.key}
                      className="font-mono"
                      onChange={(event) => update(index, { key: event.target.value })}
                    />
                    {error.key ? <FieldError>{error.key}</FieldError> : null}
                  </Field>
                </div>
                <RowButtons
                  index={index}
                  count={rows.length}
                  label={t("removePageType", { key: row.key || row.label })}
                  onMove={(direction) => setRows((current) => moved(current, index, direction))}
                  onRemove={() => setRows((current) => current.filter((_, position) => position !== index))}
                />
              </div>
              <Field>
                <FieldLabel htmlFor={`${row.id}-template`}>{t("template")}</FieldLabel>
                <Textarea
                  id={`${row.id}-template`}
                  rows={5}
                  className="font-mono text-sm"
                  value={row.template}
                  onChange={(event) => update(index, { template: event.target.value })}
                />
              </Field>
              {space.properties.length > 0 ? (
                <Field data-invalid={Boolean(error.requiredProperties)}>
                  <FieldLabel>{t("requiredProperties")}</FieldLabel>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {space.properties.map((property) => (
                      <label key={property.key} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={row.requiredProperties.includes(property.key)}
                          onCheckedChange={(checked) =>
                            update(index, {
                              requiredProperties: checked
                                ? [...row.requiredProperties, property.key]
                                : row.requiredProperties.filter((key) => key !== property.key),
                            })
                          }
                        />
                        {property.label}
                      </label>
                    ))}
                  </div>
                  {error.requiredProperties ? <FieldError>{error.requiredProperties}</FieldError> : null}
                </Field>
              ) : null}
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="outline"
          onClick={() => setRows((current) => [...current, emptyPageTypeRow()])}
        >
          <Plus />
          {t("addPageType")}
        </Button>
        {fields?.pageTypes ? <FieldError>{fields.pageTypes}</FieldError> : null}
      </CardContent>
      <CardFooter>
        <Button
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ pageTypes: pageTypeDefinitions(rows) })}
        >
          {mutation.isPending ? <Spinner /> : null}
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Name and description of a space. */
export function GeneralCard({ space }: { space: Space }) {
  const t = useT(messages);
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description);
  const { mutation, fields } = useSaveSpace(space);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("general")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field data-invalid={Boolean(fields?.name)}>
          <FieldLabel htmlFor="space-name">{t("name")}</FieldLabel>
          <Input
            id="space-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
          {fields?.name ? <FieldError>{fields.name}</FieldError> : null}
        </Field>
        <Field data-invalid={Boolean(fields?.description)}>
          <FieldLabel htmlFor="space-description">{t("description")}</FieldLabel>
          <Textarea
            id="space-description"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          {fields?.description ? <FieldError>{fields.description}</FieldError> : null}
        </Field>
      </CardContent>
      <CardFooter>
        <Button
          disabled={mutation.isPending || !name.trim()}
          onClick={() => mutation.mutate({ name, description })}
        >
          {mutation.isPending ? <Spinner /> : null}
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}
