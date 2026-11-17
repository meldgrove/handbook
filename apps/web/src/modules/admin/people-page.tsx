import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Ban, Search, ShieldCheck, UsersRound } from "lucide-react";
import type { Person } from "@knowledge/shared/api/users";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page, PageHeader } from "@/components/layout/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebounced } from "@/hooks/use-debounced";
import { useMe } from "@/hooks/use-me";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { usePeople, useUpdatePerson } from "./api";
import { messages } from "./messages";

function PersonRow(props: { person: Person; isMe: boolean; onBlock: (person: Person) => void }) {
  const t = useT(messages);
  const format = useFormatter();
  const update = useUpdatePerson();
  const { person, isMe } = props;
  const label = person.name || person.email;
  const environment = person.adminSource === "environment";
  const setAdmin = (isAdmin: boolean) =>
    update.mutate(
      { id: person.id, update: { isAdmin } },
      {
        onSuccess: () =>
          toast.success(isAdmin ? t("adminOn", { name: label }) : t("adminOff", { name: label })),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  const unblock = () =>
    update.mutate(
      { id: person.id, update: { blocked: false } },
      {
        onSuccess: () => toast.success(t("unblockedDone", { name: label })),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <TableRow>
      <TableCell className="align-top whitespace-normal">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          {person.name || person.email}
          {isMe ? <span className="text-muted-foreground text-xs font-normal">({t("you")})</span> : null}
          {person.blocked ? (
            <Badge variant="destructive">
              <Ban aria-hidden />
              {t("blocked")}
            </Badge>
          ) : null}
        </div>
        {person.name ? <div className="text-muted-foreground text-sm break-all">{person.email}</div> : null}
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex flex-wrap gap-1">
          {person.spaces.map((space) => (
            <Badge key={space.slug} variant="outline" asChild>
              <Link to="/s/$space" params={{ space: space.slug }}>
                {space.name} · {t(`role_${space.role}`)}
              </Link>
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="align-top">
        {person.lastSignInAt ? format.relative(person.lastSignInAt) : t("never")}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-center gap-2">
          <Switch
            checked={person.isAdmin}
            disabled={environment || isMe || update.isPending}
            onCheckedChange={setAdmin}
            aria-label={t("makeAdmin", { name: label })}
          />
          {environment ? (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <ShieldCheck className="size-3" aria-hidden />
              {t("fromEnvironment")}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right align-top">
        {isMe || environment ? null : person.blocked ? (
          <Button variant="outline" size="sm" disabled={update.isPending} onClick={unblock}>
            {t("unblock")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => props.onBlock(person)}>
            {t("block")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export function AdminPeoplePage() {
  const t = useT(messages);
  const me = useMe();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const people = usePeople(q);
  const update = useUpdatePerson();
  const [blocking, setBlocking] = useState<Person | null>(null);
  const blockingLabel = blocking ? blocking.name || blocking.email : "";
  return (
    <Page>
      <PageHeader title={t("peopleTitle")} description={t("peopleDescription")} />
      <div className="relative max-w-sm">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search")}
          aria-label={t("search")}
          className="pl-8"
        />
      </div>
      {people.isLoading ? (
        <LoadingState />
      ) : people.isError || !people.data ? (
        <ErrorState error={people.error} onRetry={() => void people.refetch()} />
      ) : people.data.items.length === 0 ? (
        <EmptyState icon={<UsersRound />} title={t("noPeople")} />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colPerson")}</TableHead>
                <TableHead>{t("colSpaces")}</TableHead>
                <TableHead>{t("colLastSignIn")}</TableHead>
                <TableHead>{t("colAdmin")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("colAccess")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.data.items.map((person) => (
                <PersonRow key={person.id} person={person} isMe={person.id === me.id} onBlock={setBlocking} />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <ConfirmDialog
        open={blocking !== null}
        onOpenChange={(open) => !open && setBlocking(null)}
        title={t("blockTitle", { name: blockingLabel })}
        description={t("blockDescription")}
        confirmLabel={t("block")}
        destructive
        onConfirm={() =>
          blocking &&
          update.mutateAsync({ id: blocking.id, update: { blocked: true } }).then(
            () => toast.success(t("blockedDone", { name: blockingLabel })),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </Page>
  );
}
