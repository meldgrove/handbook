import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus, UpdatesResponse } from "@handbook/shared/api/updates";
import type { Me } from "@handbook/shared/api/users";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateButton } from "./update-button";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const PENDING_KEY = "handbook.update-install";

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

/** A JSON answer, an HTML page (a proxy's sign-in page), no answer at all (`fail`), or none until aborted (`stall`). */
type Reply = { status?: number; body?: unknown; html?: string; fail?: boolean; stall?: boolean };

/** Replies by "METHOD /path"; a list answers one call each and repeats its last entry; a function decides per call. */
function stubApi(routes: Record<string, Reply | Reply[] | (() => Reply)>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    const entry = routes[key];
    const reply =
      typeof entry === "function"
        ? entry()
        : Array.isArray(entry)
          ? entry.length > 1
            ? entry.shift()!
            : entry[0]!
          : entry;
    if (!reply) return new Response(JSON.stringify({ error: { code: "x", message: key } }), { status: 500 });
    if (reply.fail) throw new TypeError("Failed to fetch");
    if (reply.stall) {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)),
      );
    }
    if (reply.html !== undefined) {
      return new Response(reply.html, {
        status: reply.status ?? 200,
        headers: { "content-type": "text/html" },
      });
    }
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
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <UpdateButton />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** The status requests among the stub's calls. */
const statusCalls = (fetch: ReturnType<typeof stubApi>) =>
  fetch.mock.calls.filter(([url]) => url === "/api/v1/admin/updates");

/** The updater's times are whole seconds. */
const updaterTime = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

const unreachable: UpdatesResponse = {
  app: { version: "0.2.0" },
  reachable: false,
  updater: null,
  error: "The update service is not reachable.",
};

describe("UpdateButton", () => {
  beforeEach(() => {
    sessionStorage.clear();
    toast.success.mockClear();
    toast.error.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}")).toMatchObject({
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
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}")).toMatchObject({
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
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("stops waiting on request after 15 minutes", async () => {
    const startedAt = Date.now() - 16 * 60_000;
    sessionStorage.setItem(
      PENDING_KEY,
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
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    // The updater still reports it, but this tab does not follow it again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(
      within(await screen.findByRole("dialog")).queryByRole("button", { name: "Stop waiting" }),
    ).toBeNull();
  });

  it("ends an unconfirmed attempt after 60 seconds while every status request fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        version: "0.2.1",
        startedAt: Date.now(),
        confirmed: false,
        reason: "Bad gateway",
        outageAt: null,
      }),
    );
    const fetch = stubApi({ "GET /api/v1/admin/updates": { fail: true } });
    renderButton();
    await act(() => vi.advanceTimersByTimeAsync(59_000));
    expect(fetch.mock.calls.length).toBeGreaterThan(20);
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("The installation could not be confirmed", {
      description: "Failed to fetch",
    });
  });

  it("says that an unconfirmed attempt did not start when the updater answered without it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        version: "0.2.1",
        startedAt: Date.now(),
        confirmed: false,
        reason: "Bad gateway",
        outageAt: null,
      }),
    );
    stubApi({ "GET /api/v1/admin/updates": { body: available } });
    renderButton();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("The installation did not start", {
      description: "Bad gateway",
    });
    expect(await screen.findByRole("button", { name: "Update available · 0.2.1" })).toBeInTheDocument();
  });

  it("keeps ignoring the installation after Stop waiting while the updater does not answer", async () => {
    const startedAt = Date.now() - 16 * 60_000;
    const installing = {
      version: "0.2.1",
      startedAt: updaterTime(startedAt),
      manual: true,
      stage: "pulling" as const,
    };
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        version: "0.2.1",
        startedAt,
        confirmed: true,
        reason: null,
        outageAt: null,
        installStartedAt: installing.startedAt,
      }),
    );
    let back = false;
    stubApi({
      "GET /api/v1/admin/updates": () =>
        back ? { body: answer({ ...available.updater, installing }) } : { body: unreachable },
    });
    renderButton();
    const user = userEvent.setup();
    // An unreachable updater while following: the app restarts, an outage.
    await user.click(await screen.findByRole("button", { name: "Restarting…" }));
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}").outageAt).toEqual(expect.any(Number));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("Handbook restarts. This page reloads when it is back.");
    await user.click(within(popover).getByRole("button", { name: "Stop waiting" }));
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();

    // The updater is back and still reports the installation: not followed again.
    back = true;
    await user.click(
      await screen.findByRole("button", { name: "No update service. See the deployment guide." }),
    );
    await user.click(await screen.findByRole("button", { name: "Installing 0.2.1…" }));
    const after = await screen.findByRole("dialog");
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(after).toHaveTextContent("This takes longer than expected.");
    expect(after).not.toHaveTextContent("This page reloads");
    expect(within(after).queryByRole("button", { name: "Stop waiting" })).toBeNull();
  });

  it("stops asking for the status after a sign-in page, and keeps the attempt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const startedAt = Date.now();
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ version: "0.2.1", startedAt, confirmed: true, reason: null, outageAt: null }),
    );
    const installing = {
      version: "0.2.1",
      startedAt: updaterTime(startedAt),
      manual: true,
      stage: "pulling" as const,
    };
    let signedOut = false;
    const fetch = stubApi({
      "GET /api/v1/admin/updates": () =>
        signedOut
          ? { html: "<!doctype html><title>Sign in</title>" }
          : { body: answer({ ...available.updater, installing }) },
    });
    renderButton();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    signedOut = true;
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    const calls = statusCalls(fetch).length;
    // No interval, no focus, no reconnect.
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(statusCalls(fetch).length).toBe(calls);
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}")).toMatchObject({ version: "0.2.1" });
  });

  it("shows a newer offer over an old failure, with the failure as a line", async () => {
    stubApi({
      "GET /api/v1/admin/updates": {
        body: answer({
          available: { ...available.updater!.available!, version: "0.2.2", installsAt: null },
          last: {
            version: "0.2.1",
            result: "rolled-back",
            message: "container web is unhealthy. 0.2.0 runs again.",
            finishedAt: updaterTime(Date.now()),
          },
        }),
      },
    });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update available · 0.2.2" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("0.2.1 failed: container web is unhealthy. 0.2.0 runs again.");
    expect(within(popover).getByRole("button", { name: "Install now" })).toBeInTheDocument();
  });

  it("shows a restored attempt while every status request fails, with Stop waiting after 15 minutes", async () => {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        version: "0.2.1",
        startedAt: Date.now() - 16 * 60_000,
        confirmed: true,
        reason: null,
        outageAt: null,
      }),
    );
    stubApi({ "GET /api/v1/admin/updates": { fail: true } });
    renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restarting…" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("Installing 0.2.1…");
    expect(popover).toHaveTextContent("This takes longer than expected.");
    await user.click(within(popover).getByRole("button", { name: "Stop waiting" }));
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("counts a status 5xx as an outage, so an acceptance without app version completes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const startedAt = Date.now();
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ version: "0.2.1", startedAt, confirmed: true, reason: null, outageAt: null }),
    );
    const accepted = answer({
      mode: "platform",
      last: { version: "0.2.1", result: "accepted", message: null, finishedAt: updaterTime(startedAt) },
    });
    stubApi({
      "GET /api/v1/admin/updates": [
        {
          status: 503,
          body: { app: { version: null }, reachable: true, updater: null, error: "The updater is busy." },
        },
        { body: { ...accepted, app: { version: null } } },
      ],
    });
    renderButton();
    expect(await screen.findByRole("button", { name: "Restarting…" })).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}")).toMatchObject({
      outageAt: expect.any(Number),
      lastError: "The updater is busy.",
    });
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    expect(toast.success).toHaveBeenCalledWith("Updated to 0.2.1");
  });

  it("gives every status request a timeout, also without an installation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Timeouts on the fake clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetch = stubApi({ "GET /api/v1/admin/updates": { stall: true } });
    renderButton();
    await waitFor(() => expect(statusCalls(fetch)).toHaveLength(1));
    const signal = statusCalls(fetch)[0]![1]!.signal!;
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(signal.aborted).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(signal.aborted).toBe(true);
  });

  it("does not let the install wait share a status request that started before", async () => {
    let stall = false;
    const fetch = stubApi({
      "GET /api/v1/admin/updates": () => (stall ? { stall: true } : { body: available }),
      "POST /api/v1/admin/updates/install": {
        status: 502,
        body: { error: { code: "x", message: "Bad gateway" } },
      },
    });
    const { client } = renderButton();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    // A status request hangs when the admin installs.
    stall = true;
    void client.refetchQueries({ queryKey: ["admin", "updates"] });
    await waitFor(() => expect(statusCalls(fetch)).toHaveLength(2));
    stall = false;
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install now" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
    // It is cancelled, and a new one asks at once.
    await waitFor(() => expect(statusCalls(fetch)).toHaveLength(3));
    expect(statusCalls(fetch)[1]![1]!.signal!.aborted).toBe(true);
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
