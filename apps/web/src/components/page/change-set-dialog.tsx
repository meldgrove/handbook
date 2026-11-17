import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { defineMessages, useT } from "@/i18n";
import { common } from "@/i18n/common";

const messages = defineMessages({
  en: {
    title: "Suggest this change",
    description:
      "Editors of the space review your suggestion and publish it. Describe what you changed and why.",
    name: "Title",
    namePlaceholder: "e.g. Update the VPN steps for new laptops",
    details: "Why and what (optional)",
    submit: "Save suggestion",
  },
});

/** Asks for the title and description of a new change set (a suggestion). */
export function ChangeSetDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTitle?: string;
  pending: boolean;
  errors?: Record<string, string>;
  onSubmit: (value: { title: string; description: string }) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const titleId = useId();
  const detailsId = useId();
  const [title, setTitle] = useState(props.defaultTitle ?? "");
  const [description, setDescription] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) props.onSubmit({ title: title.trim(), description: description.trim() });
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => !props.pending && props.onOpenChange(open)}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(props.errors?.title)}>
            <FieldLabel htmlFor={titleId}>{t("name")}</FieldLabel>
            <Input
              id={titleId}
              value={title}
              required
              maxLength={200}
              placeholder={t("namePlaceholder")}
              onChange={(event) => setTitle(event.target.value)}
            />
            {props.errors?.title ? <FieldError>{props.errors.title}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={detailsId}>{t("details")}</FieldLabel>
            <Textarea
              id={detailsId}
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={props.pending}
              onClick={() => props.onOpenChange(false)}
            >
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={props.pending || !title.trim()}>
              {props.pending ? <Spinner /> : null}
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
