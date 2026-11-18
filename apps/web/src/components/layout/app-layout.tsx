import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { BookOpen, ChevronsUpDown, FolderClosed, LogOut, Search, Settings, SunMoon } from "lucide-react";
import type { SpaceSummary } from "@handbook/shared/api/spaces";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useMe } from "@/hooks/use-me";
import { THEMES, useTheme, type Theme } from "@/lib/theme";
import { authClient } from "@/lib/auth-client";
import { useAuthConfig } from "@/lib/auth-config";
import { queryClient } from "@/lib/query";
import { defineMessages, useT } from "@/i18n";
import { NAVIGATION, navMessages } from "@/app/navigation";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const messages = defineMessages({
  en: {
    signOut: "Sign out",
    skip: "Skip to content",
    theme: "Appearance",
    system: "Device setting",
    light: "Light",
    dark: "Dark",
    settings: "Settings and agents",
    admin: "Admin",
    search: "Search pages",
  },
});

/** The spaces in the sidebar; modules that change spaces invalidate ["spaces"]. */
export const spacesQuery = {
  queryKey: ["spaces"] as const,
  queryFn: () => api.get<{ items: SpaceSummary[] }>("/spaces"),
  staleTime: 60_000,
};

const DEFAULT_APP_NAME = "Handbook";

export function initials(name: string) {
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function UserMenu() {
  const me = useMe();
  const m = useT(messages);
  const { theme, setTheme } = useTheme();
  const label = me.name || me.email;

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/sign-in");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          <Avatar className="size-8 rounded-lg">
            {me.image ? <AvatarImage src={me.image} alt="" /> : null}
            <AvatarFallback className="rounded-lg">{initials(label)}</AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{label}</span>
            <span className="text-muted-foreground truncate text-xs">{me.email}</span>
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{label}</div>
          <div className="text-muted-foreground truncate text-xs">
            {me.email}
            {me.isAdmin ? ` · ${m("admin")}` : ""}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoon />
            {m("theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
              {THEMES.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {m(option)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings />
            {m("settings")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut />
          {m("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppSidebar({ appName }: { appName: string }) {
  const me = useMe();
  const t = useT(navMessages);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const spaces = useQuery(spacesQuery).data?.items ?? [];
  const isActive = (to: string) =>
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <BookOpen className="size-4" />
                </div>
                <span className="truncate font-semibold">{appName}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAVIGATION.filter((group) => !group.adminOnly || me.isAdmin)
          .map((group) => (
            <SidebarGroup key={group.key}>
              <SidebarGroupLabel>{t(group.key)}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton asChild isActive={isActive(item.to)} tooltip={t(item.key)}>
                        <Link to={item.to}>
                          <item.icon />
                          <span>{t(item.key)}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))
          .flatMap((group, index) =>
            index === 0
              ? [
                  group,
                  <SidebarGroup key="spaces">
                    <SidebarGroupLabel>{t("spaces")}</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {spaces.map((space) => (
                          <SidebarMenuItem key={space.slug}>
                            <SidebarMenuButton
                              asChild
                              isActive={isActive(`/s/${space.slug}`)}
                              tooltip={space.name}
                            >
                              <Link to="/s/$space" params={{ space: space.slug }}>
                                <FolderClosed />
                                <span>{space.name}</span>
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>,
                ]
              : [group],
          )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function HeaderSearch() {
  const m = useT(messages);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (q) void navigate({ to: "/search", search: { q } });
  };
  return (
    <form role="search" onSubmit={submit} className="relative w-full max-w-md">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={m("search")}
        aria-label={m("search")}
        className="h-9 pl-8"
      />
    </form>
  );
}

/** The signed-in application frame: sidebar, header and the page. */
export function AppLayout() {
  const m = useT(messages);
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  return (
    <TooltipProvider delayDuration={300}>
      <SidebarProvider>
        <a
          href="#main"
          className="bg-background sr-only z-50 rounded-md px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          {m("skip")}
        </a>
        <AppSidebar appName={appName} />
        <SidebarInset className="min-w-0">
          <header className="bg-background/95 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <HeaderSearch />
          </header>
          <main id="main" className="flex-1">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
