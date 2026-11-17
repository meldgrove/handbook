import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, Person } from "@knowledge/shared/api/users";
import { AdminPeoplePage } from "./people-page";
import { spaceSlugFrom } from "./spaces-page";

const me: Me = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-555555555555",
  email: "ada@example.org",
  name: "Ada Lovelace",
  image: null,
  isAdmin: true,
  spaces: [],
};

function person(overrides: Partial<Person>): Person {
  return {
    id: "0b5a3e5e-3c1f-4d8e-9f3a-666666666666",
    email: "rita@example.org",
    name: "Rita Reader",
    isAdmin: false,
    adminSource: null,
    blocked: false,
    spaces: [],
    lastSignInAt: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function routeFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`];
      return new Response(JSON.stringify(body ?? { error: { code: "x", message: "No reply" } }), {
        status: body ? 200 : 500,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function renderPeople() {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/people",
    component: () => (
      <Suspense fallback={null}>
        <AdminPeoplePage />
      </Suspense>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/admin/people"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("admin", () => {
  it("makes space slugs from names", () => {
    expect(spaceSlugFrom("People & Culture")).toBe("people-culture");
    expect(spaceSlugFrom("A".repeat(60))).toHaveLength(40);
  });

  it("protects yourself and admins from ADMIN_EMAILS", async () => {
    routeFetch({
      "GET /api/v1/me": me,
      "GET /api/v1/admin/people": {
        items: [
          person({ id: me.id, email: me.email, name: me.name, isAdmin: true, adminSource: "app" }),
          person({
            id: "0b5a3e5e-3c1f-4d8e-9f3a-777777777777",
            email: "root@example.org",
            name: "",
            isAdmin: true,
            adminSource: "environment",
          }),
          person({ spaces: [{ slug: "it", name: "IT", role: "editor" }] }),
        ],
      },
    });
    renderPeople();
    const self = (await screen.findByText("(you)")).closest("tr")!;
    expect(within(self).getByRole("switch")).toBeDisabled();
    expect(within(self).queryByRole("button", { name: "Block" })).not.toBeInTheDocument();
    const environment = screen.getByText("root@example.org").closest("tr")!;
    expect(within(environment).getByRole("switch")).toBeDisabled();
    expect(within(environment).getByText("From ADMIN_EMAILS")).toBeInTheDocument();
    const rita = screen.getByText("Rita Reader").closest("tr")!;
    expect(within(rita).getByRole("switch")).toBeEnabled();
    expect(within(rita).getByRole("button", { name: "Block" })).toBeInTheDocument();
    expect(within(rita).getByRole("link", { name: "IT · editor" })).toHaveAttribute("href", "/s/it");
  });
});
