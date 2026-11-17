import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@knowledge/shared/api/pages";
import type { Space } from "@knowledge/shared/api/spaces";
import { PageView } from "./page-view";

const abilities = {
  editLive: true,
  review: true,
  manage: false,
  manageOwners: false,
  propose: true,
  seeDrafts: true,
};

const space: Space = {
  id: "5f0c2a52-7f4a-4f0f-9a37-1f2d3c4b5a69",
  slug: "it",
  name: "IT",
  description: "",
  archived: false,
  pageCount: 2,
  myRole: "editor",
  updatedAt: "2026-11-17T09:00:00.000Z",
  properties: [{ key: "systems", label: "Systems", type: "list", options: [], required: false, help: "" }],
  pageTypes: [{ key: "workflow", label: "Workflow", template: "", requiredProperties: [] }],
  abilities,
  openChangeSets: 0,
  createdAt: "2026-11-01T09:00:00.000Z",
};

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: "0b7f9d2e-3c4a-4e5f-8a6b-7c8d9e0f1a2b",
    space: "it",
    spaceName: "IT",
    path: "network/vpn",
    parentId: null,
    position: 0,
    title: "VPN",
    description: "Connect from home.",
    status: "deprecated",
    type: "workflow",
    tags: ["network"],
    revision: 3,
    updatedAt: "2026-11-17T09:00:00.000Z",
    markdown: "---\ntitle: VPN\n---\n\n# VPN\n\nUse the [laptop guide](../laptop).\n",
    body: "# VPN\n\nUse the [laptop guide](../laptop).\n",
    properties: { title: "VPN", systems: ["Firewall", "Laptop"], replaced_by: "remote-access" },
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedBy: { id: null, name: "Ada", email: "ada@example.org" },
    breadcrumbs: [
      { id: "1b7f9d2e-3c4a-4e5f-8a6b-7c8d9e0f1a2b", space: "it", path: "network", title: "Network" },
    ],
    children: [],
    backlinks: [
      { id: "2b7f9d2e-3c4a-4e5f-8a6b-7c8d9e0f1a2b", space: "hr", path: "start", title: "First day" },
    ],
    lock: { user: { id: null, name: "Kim", email: null }, since: "2026-11-17T09:30:00.000Z", mine: false },
    draft: null,
    changeSets: [{ number: 4, title: "New VPN address", status: "in_review" }],
    abilities,
    ...overrides,
  };
}

function render404(reply: Page) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      const body = path === "/api/v1/spaces/it" ? space : reply;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const view = createRoute({
    getParentRoute: () => root,
    path: "/s/$space/$",
    component: () => <PageView space="it" path="network/vpn" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([view]),
    history: createMemoryHistory({ initialEntries: ["/s/it/network/vpn"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("PageView", () => {
  it("shows the page with its properties, notices and links for editors", async () => {
    render404(page());
    expect(await screen.findByRole("heading", { level: 1, name: "VPN" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/pages/0b7f9d2e-3c4a-4e5f-8a6b-7c8d9e0f1a2b/edit",
    );
    expect(screen.getByRole("link", { name: "Suggest an edit" })).toHaveAttribute(
      "href",
      "/pages/0b7f9d2e-3c4a-4e5f-8a6b-7c8d9e0f1a2b/edit?changeSet=new",
    );
    expect(screen.getByText(/Kim started editing this page/)).toBeInTheDocument();
    expect(screen.getByText(/This page is deprecated./)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "remote-access" })[0]).toHaveAttribute(
      "href",
      "/s/it/network/remote-access",
    );
    expect(screen.getByRole("link", { name: "#4 New VPN address" })).toHaveAttribute("href", "/changes/4");
    expect(await screen.findByText("Firewall, Laptop")).toBeInTheDocument();
    expect(screen.getByText("Systems")).toBeInTheDocument();
    expect(screen.getByText("Workflow")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "laptop guide" })).toHaveAttribute("href", "/s/it/laptop");
    expect(screen.getByRole("link", { name: "First day" })).toHaveAttribute("href", "/s/hr/start");
    // The title heading in the body is not shown twice.
    expect(screen.getAllByRole("heading", { name: "VPN" })).toHaveLength(1);
  });

  it("offers readers only a suggestion", async () => {
    render404(page({ abilities: { ...abilities, editLive: false, review: false }, lock: null }));
    expect(await screen.findByRole("link", { name: "Suggest an edit" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });
});
