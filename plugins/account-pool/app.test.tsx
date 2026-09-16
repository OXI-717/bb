// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const STATUS_CACHE_KEY = "account-pool:status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function measureAccountRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const handle = this.querySelector(
        'button[aria-roledescription="sortable"]',
      );
      const rows = Array.from(this.parentElement?.children ?? []);
      return new DOMRect(0, handle ? rows.indexOf(this) * 60 : 0, 600, 60);
    },
  );
}

async function keyboardMove(handle: HTMLElement, code = "ArrowDown") {
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space" });
  await waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.keyDown(document, { code });
}

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "person@example.com",
    email: "person@example.com",
    accountUuid: null,
    subscriptionType: "Max",
    rateLimitTier: "default_claude_max_5x",
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: 2,
    lastUsedHostId: "host-one",
    role: "primary",
    cap: null,
    lastUsedHostName: "bee",
    fiveHourUtilization: 0.21,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    observedAt: 1,
    heldUntil: null,
    error: null,
    inFlight: 0,
    capLimit: null,
    eligible: true,
    capReached: false,
    drainOpensAt: null,
    status: "ready",
    ...overrides,
  };
}

function status(
  accounts: AccountSummary[] = [account()],
  activeAccounts: PoolStatus["activeAccounts"] = { claude: null, codex: null },
): PoolStatus {
  return {
    route: "/api/v1/plugins/account-pool/http",
    enabledAccountCount: accounts.filter((item) => item.enabled).length,
    inFlight: 2,
    accepting: true,
    hosts: [
      { hostId: "host-one", hostName: "bee", mintedAt: 1, lastUsedAt: 2 },
    ],
    accounts,
    activeAccounts,
    routing: { claude: true, codex: true },
  };
}

function config(overrides: Partial<AccountPoolConfig> = {}): AccountPoolConfig {
  return {
    anthropicUpstreamBaseUrl: "https://api.anthropic.com",
    codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    switchThreshold: 0.98,
    routingStrategy: "sequential",
    reserveDrainHours: 24,
    restDays: [0, 6],
    ...overrides,
  };
}

function render(
  accounts = [account()],
  extraRpc: Record<string, () => object | null | Promise<object | null>> = {},
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () => status(accounts),
        "config.get": () => config(),
        ...extraRpc,
      },
      openUrl: () => true,
    },
  );
}

describe("Account Pool settings", () => {
  it("renders cached accounts as refreshing until live status arrives, then caches it", async () => {
    window.localStorage.setItem(
      STATUS_CACHE_KEY,
      JSON.stringify(status([account({ fiveHourUtilization: 0.21 })])),
    );
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.getByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("21%")).toBeTruthy();
    expect(slot.getByText("refreshing usage…")).toBeTruthy();
    expect(slot.getByText(/· refreshing…$/)).toBeTruthy();
    expect(slot.queryByText("Loading…")).toBeNull();
    expect(slot.queryByText("No accounts in the pool")).toBeNull();
    live.resolve(status([account({ fiveHourUtilization: 0.6 })]));
    expect(await slot.findByText("60%")).toBeTruthy();
    expect(slot.queryByText("refreshing usage…")).toBeNull();
    expect(slot.queryByText(/· refreshing…$/)).toBeNull();
    const cached = JSON.parse(
      window.localStorage.getItem(STATUS_CACHE_KEY) ?? "null",
    ) as PoolStatus;
    expect(cached.accounts[0]?.fiveHourUtilization).toBe(0.6);
  });

  it("ignores a malformed status cache and shows the loading state", async () => {
    window.localStorage.setItem(STATUS_CACHE_KEY, '{"accounts":"nope"}');
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.getAllByText("Loading…")).toHaveLength(2);
    live.resolve(status());
    expect(await slot.findByText("person@example.com")).toBeTruthy();
  });

  it("marks a row as refreshing while its usage refresh is in flight", async () => {
    const refresh = deferred<{ account: null }>();
    const slot = render([account()], {
      "account.refreshUsage": () => refresh.promise,
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "person@example.com actions" }),
    );
    fireEvent.click(await slot.findByText("Refresh usage"));
    expect(await slot.findByText("refreshing usage…")).toBeTruthy();
    refresh.resolve({ account: null });
    await waitFor(() =>
      expect(slot.queryByText("refreshing usage…")).toBeNull(),
    );
  });

  it("renders fixed quota slots with missing buckets as em dashes", async () => {
    const slot = render();
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("5H")).toBeTruthy();
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.getByText("FABLE")).toBeTruthy();
    expect(slot.getAllByText("—")).toHaveLength(2);
    expect(
      slot.getByText("Hub accepting · 2 in flight · used by bee"),
    ).toBeTruthy();
  });

  it("keeps the quota slots visible at mobile widths", async () => {
    const slot = render();
    const group = (await slot.findByText("5H")).parentElement?.parentElement;
    expect(group).toBeTruthy();
    expect(group?.className).not.toMatch(/(^|\s)hidden(\s|$)/u);
  });

  it("renders only the windows a Codex account reports and no Fable slot", async () => {
    const blockingResetAt = Date.now() + 6 * 24 * 60 * 60 * 1_000;
    const slot = render([
      account({
        id: "22222222-2222-4222-8222-222222222222",
        provider: "codex",
        label: "pro@example.com",
        codexAccountId: "chatgpt-account",
        status: "exhausted",
        fiveHourUtilization: 0.25,
        fiveHourResetAt: Date.now() + 60 * 60 * 1_000,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 10_080,
            utilization: 1,
            resetAt: blockingResetAt,
            status: "rejected",
            observedAt: 1,
            source: "usage",
          },
        ],
      }),
    ]);
    expect(await slot.findByText("pro@example.com")).toBeTruthy();
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.getByText("100%")).toBeTruthy();
    expect(slot.queryByText("5H")).toBeNull();
    expect(slot.queryByText("FABLE")).toBeNull();
    expect(
      slot.getByText(
        `Exhausted · resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(blockingResetAt)}`,
      ),
    ).toBeTruthy();
    fireEvent.click(
      await slot.findByRole("button", { name: "Open pro@example.com details" }),
    );
    expect(await slot.findByText("Weekly")).toBeTruthy();
    expect(slot.queryByText("5 hour")).toBeNull();
    expect(slot.queryByText("7 day")).toBeNull();
  });

  it.each([
    {
      action: "Disable",
      method: "account.disable",
      input: { id: account().id },
    },
    {
      action: "Refresh usage",
      method: "account.refreshUsage",
      input: { accountId: account().id },
    },
  ])(
    "dispatches $action to its RPC contract",
    async ({ action, method, input }) => {
      const slot = render([account()], {
        [method]: () => ({ account: null }),
      });
      fireEvent.pointerDown(
        await slot.findByRole("button", { name: "person@example.com actions" }),
      );
      fireEvent.click(await slot.findByText(action));
      expect(slot.rpcCalls).toContainEqual({ method, input });
    },
  );

  it("confirms Remove before dispatching its RPC contract", async () => {
    const slot = render([account()], {
      "account.remove": () => ({ removed: true }),
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "person@example.com actions" }),
    );
    fireEvent.click(await slot.findByText("Remove"));
    expect(await slot.findByText("Remove person@example.com?")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "account.remove")).toBe(
      false,
    );
    fireEvent.click(slot.getByRole("button", { name: "Remove" }));
    expect(slot.rpcCalls).toContainEqual({
      method: "account.remove",
      input: { id: account().id },
    });
  });

  it("opens the correct provider sign-in flow from each Add account menu", async () => {
    const slot = render([], {
      "login.start": () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        authorizeUrl: "https://claude.ai/oauth/authorize",
      }),
      "codexLogin.start": () => ({
        sessionId: "33333333-3333-4333-8333-333333333333",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: Date.now() + 600_000,
        intervalMs: 60_000,
      }),
    });
    const addButtons = await slot.findAllByRole("button", {
      name: "Add account",
    });
    fireEvent.pointerDown(addButtons[0]!);
    fireEvent.click(
      await slot.findByText("Sign in to Claude", { selector: "span.block" }),
    );
    expect(
      await slot.findByLabelText("Claude authorization code"),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.pointerDown(addButtons[1]!);
    fireEvent.click(
      await slot.findByText("Sign in to Codex", { selector: "span.block" }),
    );
    expect(
      (await slot.findByLabelText("Codex user code")).textContent,
    ).toContain("ABCD-1234");
  });

  it("persists provider routing from the section switch", async () => {
    const slot = render([account()], {
      "routing.set": () => ({ provider: "claude", enabled: false }),
    });
    fireEvent.click(
      await slot.findByRole("switch", { name: "Route Claude threads" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "routing.set",
        input: { provider: "claude", enabled: false },
      }),
    );
  });

  it("edits Advanced config fields and shows URL validation inline", async () => {
    const nextConfig = config({
      anthropicUpstreamBaseUrl: "https://proxy.example.com",
    });
    const slot = render([account()], {
      "config.set": () => nextConfig,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    const anthropic = await slot.findByLabelText("Anthropic upstream base URL");
    if (!(anthropic instanceof HTMLInputElement)) {
      throw new Error("Expected the Anthropic config field to be an input.");
    }
    await waitFor(() =>
      expect(anthropic.value).toBe("https://api.anthropic.com"),
    );
    expect(slot.getByLabelText("Codex upstream base URL")).toBeTruthy();
    expect(slot.getByLabelText("Quota switch threshold")).toBeTruthy();

    fireEvent.change(anthropic, { target: { value: "ftp://invalid.example" } });
    fireEvent.blur(anthropic);
    expect(await slot.findByText("Must be an HTTP or HTTPS URL.")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "config.set")).toBe(
      false,
    );

    fireEvent.change(anthropic, {
      target: { value: "https://proxy.example.com" },
    });
    fireEvent.blur(anthropic);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { anthropicUpstreamBaseUrl: "https://proxy.example.com" },
      }),
    );
  });

  it("marks the current account, reserve role, and live cap in each row", async () => {
    const work = account({
      id: "22222222-2222-4222-8222-222222222222",
      label: "work@example.com",
      email: "work@example.com",
      role: "reserve",
      capLimit: 0.39,
    });
    const slot = render([account(), work], {
      "status.get": () =>
        status([account(), work], { claude: account().id, codex: null }),
    });
    expect(
      await slot.findByText("Current Claude: person@example.com"),
    ).toBeTruthy();
    expect(slot.getByText("Current Codex: none")).toBeTruthy();
    expect(slot.getAllByText("Current")).toHaveLength(1);
    expect(slot.getAllByText("Reserve")).toHaveLength(1);
    expect(slot.getByText("cap 39% now (15%→98%)")).toBeTruthy();
  });

  it("saves a role and a weekly cap from the row actions", async () => {
    const slot = render([account()], {
      "account.setRole": () => ({ account: null }),
      "account.setCap": () => ({ account: null }),
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "person@example.com actions" }),
    );
    fireEvent.click(await slot.findByText("Set role…"));
    fireEvent.click(await slot.findByRole("button", { name: "Reserve" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.setRole",
        input: { accountId: account().id, role: "reserve" },
      }),
    );
    await waitFor(() => expect(slot.queryByText("Set role")).toBeNull());
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "person@example.com actions" }),
    );
    fireEvent.click(await slot.findByText("Set weekly cap…"));
    fireEvent.change(await slot.findByLabelText("Cap at week start"), {
      target: { value: "0.2" },
    });
    fireEvent.change(slot.getByLabelText("Cap at reset"), {
      target: { value: "0.9" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.setCap",
        input: { accountId: account().id, cap: { early: 0.2, late: 0.9 } },
      }),
    );
  });

  it("switches balanced routing and saves drain hours and rest days", async () => {
    const slot = render([account()], {
      "config.set": () => config({ routingStrategy: "balanced" }),
    });
    const balanced = await slot.findByRole("switch", {
      name: "Balanced routing",
    });
    await waitFor(() =>
      expect((balanced as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(balanced);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { routingStrategy: "balanced" },
      }),
    );
    const drain = await slot.findByLabelText("Reserve drain hours");
    await waitFor(() =>
      expect((drain as HTMLInputElement).disabled).toBe(false),
    );
    fireEvent.change(drain, { target: { value: "12" } });
    fireEvent.blur(drain);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { reserveDrainHours: 12 },
      }),
    );
    expect(
      slot.getByText("Sun, Sat do not count toward a reset."),
    ).toBeTruthy();
    const friday = slot.getByRole("button", { name: "Fri" });
    await waitFor(() =>
      expect((friday as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(friday);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { restDays: [0, 5, 6] },
      }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Sun" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { restDays: [6] },
      }),
    );
  });

  it("lists when each reserve account joins the primary ones", async () => {
    const soon = account({
      id: "22222222-2222-4222-8222-222222222222",
      label: "work-soon@example.com",
      email: "work-soon@example.com",
      role: "reserve",
      capLimit: 0.8,
      drainOpensAt: Date.now() - 60_000,
      sevenDayResetAt: Date.now() + 60 * 60 * 1_000,
    });
    const later = account({
      id: "33333333-3333-4333-8333-333333333333",
      label: "work-later@example.com",
      email: "work-later@example.com",
      role: "reserve",
      capLimit: 0.3,
      drainOpensAt: Date.now() + 2 * 24 * 60 * 60 * 1_000,
      sevenDayResetAt: Date.now() + 3 * 24 * 60 * 60 * 1_000,
    });
    const slot = render([account(), later, soon]);
    expect(await slot.findByText("Drain windows")).toBeTruthy();
    expect(slot.getByText("open now")).toBeTruthy();
    const table = slot.getByLabelText("Claude drain windows");
    expect(slot.queryByLabelText("Codex drain windows")).toBeNull();
    const rows = Array.from(table.querySelectorAll("tbody tr")).map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("work-soon@example.com");
    expect(rows[1]).toContain("work-later@example.com");
    expect(rows[1]).toContain("30%");
    expect(rows[1]).toMatch(/\d{2}\.\d{2} \d{2}:\d{2} \(/);
  });

  it("separates a capped account from a reserve account on standby", async () => {
    const capped = account({
      role: "reserve",
      cap: { early: 0.15, late: 0.98 },
      capLimit: 0.2,
      capReached: true,
      eligible: false,
      sevenDayUtilization: 0.5,
      sevenDayResetAt: Date.now() + 2 * 24 * 60 * 60 * 1_000,
    });
    const standby = account({
      id: "22222222-2222-4222-8222-222222222222",
      label: "standby@example.com",
      email: "standby@example.com",
      role: "reserve",
      capLimit: 0.6,
      eligible: false,
    });
    const slot = render([capped, standby]);
    expect(
      await slot.findByText((text) => text.startsWith("Capped · ")),
    ).toBeTruthy();
    expect(slot.getByText("Reserve · standby")).toBeTruthy();
    expect(slot.getByText("50%").className).toContain("text-destructive-text");
  });

  it("names a Codex window without a reported length by its slot", async () => {
    const codex = account({
      provider: "codex",
      kind: "oauth",
      label: "codex@example.com",
      email: "codex@example.com",
      subscriptionType: "pro",
      fiveHourUtilization: null,
      limitWindows: [
        {
          slot: "secondary",
          windowMinutes: null,
          utilization: 0.12,
          resetAt: null,
          status: null,
          observedAt: 1,
          source: "header",
        },
      ],
    });
    const slot = render([codex]);
    expect(await slot.findByText("7D")).toBeTruthy();
    expect(slot.queryByText("LIMIT 2")).toBeNull();
    fireEvent.click(
      await slot.findByRole("button", { name: "Open codex@example.com" }),
    );
    expect(await slot.findByText("Weekly")).toBeTruthy();
    expect(slot.queryByText("Secondary limit")).toBeNull();
  });

  it("explains the role, the weekly cap, and the effective skip limit in the detail dialog", async () => {
    const work = account({
      role: "reserve",
      cap: { early: 0.15, late: 0.98 },
      capLimit: 0.45,
      sevenDayUtilization: 0.5,
      sevenDayResetAt: Date.now() + 3 * 24 * 60 * 60 * 1_000,
    });
    const slot = render([work]);
    fireEvent.click(
      await slot.findByRole("button", { name: "Open person@example.com" }),
    );
    expect(await slot.findAllByText("Reserve")).toHaveLength(2);
    expect(slot.getByText("15% → 98% · 45% now")).toBeTruthy();
    expect(
      slot.getByText(
        "Used only when no primary account is eligible, or within 24 working hours of its weekly reset.",
      ),
    ).toBeTruthy();
    expect(
      slot.getByText((text) => text.includes("will be skipped at 45%")),
    ).toBeTruthy();
  });

  it("shows every observed family bucket in the detail dialog", async () => {
    const fable = {
      utilization: 0.91,
      resetAt: Date.now() + 3_600_000,
      status: null,
      observedAt: 1,
      source: "usage" as const,
    };
    const slot = render([
      account({
        familyWeekly: {
          fable,
          sonnet: null,
          opus: { ...fable, utilization: 0.2 },
          haiku: null,
          other: null,
        },
      }),
    ]);
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Open person@example.com details",
      }),
    );
    expect(await slot.findByText("Fable 7 day")).toBeTruthy();
    expect(slot.getByText("Opus 7 day")).toBeTruthy();
  });

  it("shows the email beside a display-name label in the row and detail dialog", async () => {
    const slot = render([
      account({ label: "Person Example", email: "person@example.com" }),
      account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Claude API key",
        email: null,
      }),
    ]);
    expect(await slot.findByText("Person Example")).toBeTruthy();
    expect(slot.getAllByText("person@example.com")).toHaveLength(1);
    fireEvent.click(
      slot.getByRole("button", { name: "Open Person Example details" }),
    );
    expect(await slot.findByText("Email")).toBeTruthy();
    expect(slot.getAllByText("person@example.com")).toHaveLength(2);
  });

  function codexLoginStart() {
    return {
      sessionId: "33333333-3333-4333-8333-333333333333",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: Date.now() + 600_000,
      intervalMs: 60_000,
    };
  }

  function mockCompactViewport(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)" && matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("names the sign-in dialog once and keeps the step instructions", async () => {
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const dialog = await slot.findByRole("dialog", {
      name: "Sign in to Codex",
    });
    expect(
      slot.getAllByRole("heading", { name: "Sign in to Codex" }),
    ).toHaveLength(1);
    expect(dialog.textContent).toContain(
      "Open the verification page, sign in to ChatGPT, and enter this code.",
    );
    expect(
      (await slot.findByLabelText("Codex user code")).textContent,
    ).toContain("ABCD-1234");
    expect(slot.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it.each([false, true])(
    "cancels the pending sign-in from the header close with compact viewport %s",
    async (compact) => {
      mockCompactViewport(compact);
      const slot = render([], {
        "codexLogin.start": codexLoginStart,
        "codexLogin.poll": () => ({ status: "pending" }),
        "codexLogin.cancel": () => ({ cancelled: true }),
      });
      fireEvent.click(
        await slot.findByRole("button", { name: "Sign in to Codex" }),
      );
      await slot.findByRole("dialog", { name: "Sign in to Codex" });
      fireEvent.click(slot.getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "codexLogin.cancel",
          input: { sessionId: codexLoginStart().sessionId },
        }),
      );
      await waitFor(() =>
        expect(slot.queryByRole("dialog", { name: "Sign in to Codex" })).toBe(
          null,
        ),
      );
      const polls = () =>
        slot.rpcCalls.filter((call) => call.method === "codexLogin.poll")
          .length;
      const settled = polls();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(polls()).toBe(settled);
    },
  );

  it("copies the exact device code and distinguishes it from the URL copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Copy Codex sign-in code" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-1234"));
    await waitFor(() =>
      expect(slot.getByText("Sign-in code copied")).toBeTruthy(),
    );
    expect(
      slot
        .getByRole("button", { name: "Copy Codex sign-in code" })
        .querySelector('[data-icon="Check"]'),
    ).not.toBeNull();

    fireEvent.click(
      slot.getByRole("button", { name: "Copy Codex authorization URL" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "https://auth.openai.com/codex/device",
      ),
    );
  });

  it("does not claim success when copying the device code fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const button = await slot.findByRole("button", {
      name: "Copy Codex sign-in code",
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(window.getSelection()?.toString()).toBe("ABCD-1234"),
    );
    expect(slot.queryByText("Sign-in code copied")).toBeNull();
    expect(button.querySelector('[data-icon="Check"]')).toBeNull();
  });

  it("does not claim success when copying the authorization URL fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const button = await slot.findByRole("button", {
      name: "Copy Codex authorization URL",
    });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(button.textContent).not.toContain("Copied");
    expect(slot.queryByText("Authorization URL copied")).toBeNull();
  });

  it("keeps polling and the close action working after copying the code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], {
      "codexLogin.start": codexLoginStart,
      "codexLogin.poll": () => ({ status: "pending" }),
      "codexLogin.cancel": () => ({ cancelled: true }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Copy Codex sign-in code" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-1234"));
    expect(
      (await slot.findByRole("dialog", { name: "Sign in to Codex" }))
        .textContent,
    ).toContain("Waiting for you to authorize");
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "codexLogin.cancel",
        input: { sessionId: codexLoginStart().sessionId },
      }),
    );
  });

  it("offers a fresh Codex login after device-code polling fails", async () => {
    let starts = 0;
    const slot = render([], {
      "codexLogin.start": () => {
        starts += 1;
        return {
          sessionId: "33333333-3333-4333-8333-333333333333",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 600_000,
          intervalMs: 1,
        };
      },
      "codexLogin.poll": () => ({ status: "error", message: "Code expired." }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(starts).toBe(2));
  });
  it.each(["claude", "codex"] as const)(
    "reorders %s accounts with the keyboard and persists the displayed order",
    async (provider) => {
      measureAccountRows();
      const first = account({ label: "First", provider });
      const second = account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Second",
        provider,
      });
      const other = account({
        id: "33333333-3333-4333-8333-333333333333",
        provider: provider === "claude" ? "codex" : "claude",
        label: "Other",
      });
      const accounts = [first, second, other];
      let finishSave = () => {};
      const slot = render(accounts, {
        "account.reorder": () =>
          new Promise<null>((resolve) => {
            finishSave = () => {
              accounts.splice(0, 2, second, first);
              resolve(null);
            };
          }),
      });
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle);
      fireEvent.keyDown(document, { code: "Space" });
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "account.reorder",
          input: { provider, accountIds: [second.id, first.id] },
        }),
      );
      const providerOrder = () =>
        slot
          .getAllByRole("button", { name: /Reorder (First|Second)/ })
          .map((button) => button.getAttribute("aria-label"));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(handle.hasAttribute("disabled")).toBe(true);
      finishSave();
      await waitFor(() => expect(handle.hasAttribute("disabled")).toBe(false));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(
        slot
          .getByRole("button", { name: "Reorder Other" })
          .hasAttribute("disabled"),
      ).toBe(true);
    },
  );

  it("restores the displayed order and reports a rejected reorder", async () => {
    measureAccountRows();
    const slot = render(
      [
        account({ label: "First" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
        }),
      ],
      {
        "account.reorder": () => {
          throw new Error("Refresh the account list and try again.");
        },
      },
    );
    const handle = await slot.findByRole("button", { name: "Reorder First" });
    await keyboardMove(handle);
    fireEvent.keyDown(document, { code: "Space" });
    expect(
      await slot.findByText("Refresh the account list and try again."),
    ).toBeTruthy();
    expect(
      slot
        .getAllByRole("button", { name: /Reorder/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Reorder First", "Reorder Second"]);
    expect(handle.hasAttribute("disabled")).toBe(false);
  });

  it.each(["cancel", "unchanged"])(
    "does not save a %s drag",
    async (action) => {
      measureAccountRows();
      const slot = render([
        account({ label: "First" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
        }),
      ]);
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle, action === "cancel" ? "ArrowDown" : "ArrowUp");
      fireEvent.keyDown(document, {
        code: action === "cancel" ? "Escape" : "Space",
      });
      await waitFor(() =>
        expect(handle.getAttribute("aria-pressed")).toBeNull(),
      );
      expect(
        slot.rpcCalls.filter((call) => call.method === "account.reorder"),
      ).toEqual([]);
      expect(
        slot
          .getAllByRole("button", { name: /Reorder/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Reorder First", "Reorder Second"]);
    },
  );
});
