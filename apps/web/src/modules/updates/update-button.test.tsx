import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus, UpdatesResponse } from "@handbook/shared/api/updates";
import type { Me } from "@handbook/shared/api/users";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateButton } from "./update-button";

const me: Me = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-555555555555",
  email: "ada@example.org",
  name: "Ada Lovelace",
  image: null,
  isAdmin: true,
  spaces: [],
};

function answer(status: Partial<UpdaterStatus>): UpdatesResponse {
  return {
    app: { version: "0.2.0" },
    reachable: true,
    updater: {
      updater: "0.2.0",
      mode: "host",
      channel: "stable",
      channelLocked: null,
      installed: "0.2.0",
      available: null,
      attention: null,
      installing: null,
      last: null,
      checking: false,
      checkedAt: new Date().toISOString(),
      error: null,
      automatic: true,
      cooldown: "3d",
      window: null,
      timezone: "UTC",
      ...status,
    },
    error: null,
  };
}

const available = answer({
  available: {
    version: "0.2.1",
    preview: false,
    publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    url: "https://github.com/meldgrove/handbook/releases/tag/v0.2.1",
    notes: ["Show who changed a page last", "Fix the sign-in loop behind some proxies"],
    changes: 12,
    installsAt: new Date(Date.now() + 86_400_000).toISOString(),
    failed: null,
  },
});

type Reply = { status?: number; body: unknown };

/** Replies by "METHOD /path"; a list answers one call each and repeats its last entry. */
function stubApi(routes: Record<string, Reply | Reply[]>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    const entry = routes[key];
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    if (!reply) return new Response(JSON.stringify({ error: { code: "x", message: key } }), { status: 500 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderButton(person: Me = me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["me"], person);
  client.setQueryData(["auth-config"], { appName: "Handbook", providerName: "Keycloak" });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <UpdateButton />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("UpdateButton", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("is not there for people who are not admins", async () => {
    const fetch = stubApi({});
    const { container } = renderButton({ ...me, isAdmin: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows an update and installs it after asking", async () => {
    const fetch = stubApi({
      "GET /api/v1/admin/updates": { body: available },
      "POST /api/v1/admin/updates/install": {
        status: 202,
        body: answer({
          ...available.updater,
          installing: {
            version: "0.2.1",
            startedAt: new Date().toISOString(),
            manual: true,
            stage: "requested",
          },
        }),
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("Update available");
    expect(popover).toHaveTextContent("0.2.1 · 2 days ago");
    expect(popover).toHaveTextContent("Show who changed a page last");
    expect(popover).toHaveTextContent("and 10 more changes");
    expect(popover).toHaveTextContent("Installs automatically on");
    expect(popover).toHaveTextContent("Installed: 0.2.0 · Stable");
    expect(within(popover).getByRole("link", { name: /Release notes/ })).toHaveAttribute(
      "href",
      "https://github.com/meldgrove/handbook/releases/tag/v0.2.1",
    );

    await user.click(within(popover).getByRole("button", { name: "Install now" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Install 0.2.1 now?" });
    expect(dialog).toHaveTextContent("Handbook restarts and is unavailable for a moment.");
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/install"), expect.anything());
    await user.click(within(dialog).getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/v1/admin/updates/install",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ version: "0.2.1" }) }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("handbook.update-install") ?? "{}")).toMatchObject({
      version: "0.2.1",
      confirmed: true,
      outageAt: null,
    });
  });

  it("keeps following an installation whose request got no answer", async () => {
    stubApi({
      "GET /api/v1/admin/updates": { body: available },
      "POST /api/v1/admin/updates/install": {
        status: 502,
        body: { error: { code: "x", message: "Bad gateway" } },
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install now" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("handbook.update-install") ?? "{}")).toMatchObject({
      version: "0.2.1",
      confirmed: false,
      reason: "Bad gateway",
    });
  });

  it("forgets the attempt when the updater refuses", async () => {
    stubApi({
      "GET /api/v1/admin/updates": { body: available },
      "POST /api/v1/admin/updates/install": {
        status: 409,
        body: { ...available, error: "0.2.1 is not offered." },
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install now" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("button", { name: "Update available · 0.2.1" })).toBeInTheDocument();
    expect(sessionStorage.getItem("handbook.update-install")).toBeNull();
  });

  it("stops waiting on request after 15 minutes", async () => {
    const startedAt = Date.now() - 16 * 60_000;
    sessionStorage.setItem(
      "handbook.update-install",
      JSON.stringify({ version: "0.2.1", startedAt, confirmed: true, reason: null, outageAt: null }),
    );
    const installing = {
      version: "0.2.1",
      startedAt: new Date(startedAt).toISOString(),
      manual: true,
      stage: "requested" as const,
    };
    stubApi({ "GET /api/v1/admin/updates": { body: answer({ ...available.updater, installing }) } });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Installing 0.2.1…" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("This takes longer than expected.");
    await user.click(within(popover).getByRole("button", { name: "Stop waiting" }));
    expect(sessionStorage.getItem("handbook.update-install")).toBeNull();
    // The updater still reports it, but this tab does not follow it again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionStorage.getItem("handbook.update-install")).toBeNull();
    expect(
      within(await screen.findByRole("dialog")).queryByRole("button", { name: "Stop waiting" }),
    ).toBeNull();
  });

  it("shows a failed update with the updater's message", async () => {
    stubApi({
      "GET /api/v1/admin/updates": {
        body: answer({
          available: { ...available.updater!.available!, failed: "unhealthy", installsAt: null },
          last: {
            version: "0.2.1",
            result: "rolled-back",
            message: "container web is unhealthy. 0.2.0 runs again.",
            finishedAt: new Date().toISOString(),
          },
        }),
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update to 0.2.1 failed" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("container web is unhealthy. 0.2.0 runs again.");
    expect(popover).toHaveTextContent("0.2.0 is still running.");
    expect(within(popover).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows a failed installation the updater names only in last", async () => {
    stubApi({
      "GET /api/v1/admin/updates": {
        body: answer({
          available: { ...available.updater!.available!, installsAt: null },
          last: {
            version: "0.2.1",
            result: "failed",
            message: "The server did not take the request.",
            finishedAt: new Date().toISOString(),
          },
        }),
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update to 0.2.1 failed" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("The server did not take the request.");
    expect(within(popover).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("explains instead of installing anyway when the image tag decides", async () => {
    stubApi({
      "GET /api/v1/admin/updates": {
        body: answer({
          mode: "platform",
          channelLocked: "The image tag 0.2 set where the app is deployed decides which updates install.",
          attention: { ...available.updater!.available!, version: "0.3.0", installsAt: null },
        }),
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "0.3.0 needs upgrade steps" }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).queryByRole("button", { name: /Install anyway/ })).not.toBeInTheDocument();
    expect(popover).toHaveTextContent(
      "The image tag set where Handbook is deployed does not reach 0.3.0. Take the upgrade steps",
    );
  });

  it("shows an update while updates are off, without installing it", async () => {
    stubApi({
      "GET /api/v1/admin/updates": {
        body: answer({ ...available.updater, mode: "off", automatic: false }),
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("Show who changed a page last");
    expect(within(popover).getByRole("link", { name: /Release notes/ })).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: /Install now/ })).not.toBeInTheDocument();
    expect(popover).toHaveTextContent(
      "Automatic updates are off on this server, so it cannot install from here. See the deployment guide.",
    );
    expect(within(popover).getByRole("link", { name: "deployment guide" })).toBeInTheDocument();
  });

  it("says when updates are off and nothing is new", async () => {
    stubApi({ "GET /api/v1/admin/updates": { body: answer({ mode: "off", automatic: false }) } });
    renderButton();
    expect(
      await screen.findByRole("button", { name: "Automatic updates are off on this server" }),
    ).toBeInTheDocument();
  });

  it("says when no update service answers", async () => {
    stubApi({
      "GET /api/v1/admin/updates": {
        body: { app: { version: null }, reachable: false, updater: null, error: "Not reachable." },
      },
    });
    renderButton();
    const button = await screen.findByRole("button", {
      name: "No update service. See the deployment guide.",
    });
    expect(button).toHaveClass("opacity-60");
  });

  it("checks on click when up to date", async () => {
    const fetch = stubApi({
      "GET /api/v1/admin/updates": { body: answer({}) },
      "POST /api/v1/admin/updates/check": { body: answer({}) },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Up to date · 0.2.0" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/v1/admin/updates/check",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
