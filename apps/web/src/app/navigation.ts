import type { LucideIcon } from "lucide-react";
import {
  GitPullRequestArrow,
  Home,
  KeyRound,
  Library,
  ScrollText,
  Search,
  Tags,
  UsersRound,
} from "lucide-react";
import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    browse: "Browse",
    home: "Home",
    search: "Search",
    changes: "Change sets",
    tags: "Tags",
    spaces: "Spaces",
    admin: "Administration",
    manageSpaces: "Spaces",
    people: "People",
    serviceTokens: "Service tokens",
    audit: "Audit log",
  },
});

export type NavKey = keyof typeof navMessages.en;
export type NavItem = { key: NavKey; to: string; icon: LucideIcon };
export type NavGroup = { key: NavKey; items: NavItem[]; adminOnly: boolean };

/** The sidebar's fixed groups; the layout adds the spaces. The server checks access too. */
export const NAVIGATION: NavGroup[] = [
  {
    key: "browse",
    adminOnly: false,
    items: [
      { key: "home", to: "/", icon: Home },
      { key: "search", to: "/search", icon: Search },
      { key: "changes", to: "/changes", icon: GitPullRequestArrow },
      { key: "tags", to: "/tags", icon: Tags },
    ],
  },
  {
    key: "admin",
    adminOnly: true,
    items: [
      { key: "manageSpaces", to: "/admin/spaces", icon: Library },
      { key: "people", to: "/admin/people", icon: UsersRound },
      { key: "serviceTokens", to: "/admin/service-tokens", icon: KeyRound },
      { key: "audit", to: "/admin/audit", icon: ScrollText },
    ],
  },
];
