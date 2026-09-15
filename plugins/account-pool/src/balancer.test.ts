import { describe, expect, it } from "vitest";
import {
  balanceScore,
  gateMembership,
  rankByBalance,
  type WorkWeek,
} from "./balancer.js";
import type { AccountQuota, LimitWindow } from "./contracts.js";

const NOW = Date.UTC(2027, 0, 15, 8);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const DRAIN = 24 * HOUR;
const WEEKDAYS: WorkWeek = { restDays: [0, 6], offsetMinutes: 0 };

function quota(overrides: Partial<AccountQuota> = {}): AccountQuota {
  return {
    accountId: "00000000-0000-4000-8000-000000000000",
    fiveHourUtilization: null,
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
    observedAt: null,
    heldUntil: null,
    error: null,
    ...overrides,
  };
}

function window(
  windowMinutes: number,
  utilization: number,
  resetAt: number | null,
): LimitWindow {
  return {
    slot: windowMinutes < 24 * 60 ? "primary" : "secondary",
    windowMinutes,
    utilization,
    resetAt,
    status: "allowed",
    observedAt: NOW,
    source: "usage",
  };
}

function weekly(utilization: number, resetIn: number | null): AccountQuota {
  return quota({
    limitWindows: [
      window(10_080, utilization, resetIn === null ? null : NOW + resetIn),
    ],
  });
}

function candidate(id: string, value: AccountQuota) {
  return { account: { id }, quota: value };
}

function member(
  id: string,
  role: "primary" | "reserve",
  value: AccountQuota,
  cap: { early: number; late: number } | null = null,
) {
  return { account: { id, role, cap }, quota: value };
}

function ids(entries: readonly { account: { id: string } }[]): string[] {
  return entries.map(({ account }) => account.id);
}

describe("balanceScore", () => {
  it("prefers the account whose unused weekly quota resets sooner", () => {
    expect(balanceScore(weekly(0.5, DAY), 0, NOW)).toBeGreaterThan(
      balanceScore(weekly(0.5, 6 * DAY), 0, NOW),
    );
  });

  it("prefers more remaining weekly quota at the same reset", () => {
    expect(balanceScore(weekly(0.15, 3 * DAY), 0, NOW)).toBeGreaterThan(
      balanceScore(weekly(0.71, 3 * DAY), 0, NOW),
    );
  });

  it("spares an account whose five-hour window is nearly spent", () => {
    const hot = quota({
      limitWindows: [
        window(300, 0.99, NOW + HOUR),
        window(10_080, 0.1, NOW + DAY),
      ],
    });
    const cool = quota({
      limitWindows: [
        window(300, 0.2, NOW + HOUR),
        window(10_080, 0.4, NOW + 4 * DAY),
      ],
    });
    expect(balanceScore(cool, 0, NOW)).toBeGreaterThan(
      balanceScore(hot, 0, NOW),
    );
  });

  it("ignores windows that already reset and treats unknown quota as neutral", () => {
    const expired = quota({
      sevenDayUtilization: 0.99,
      sevenDayResetAt: NOW - HOUR,
    });
    expect(balanceScore(expired, 0, NOW)).toBe(1);
    expect(balanceScore(quota(), 0, NOW)).toBe(1);
  });

  it("does not divide by a reset that is moments away", () => {
    expect(Number.isFinite(balanceScore(weekly(0.5, 1), 0, NOW))).toBe(true);
    expect(
      Number.isFinite(balanceScore(weekly(0.5, 2 * DAY), 0, NOW + DAY, WEEKDAYS)),
    ).toBe(true);
  });

  it("spreads concurrent work away from busy accounts", () => {
    const value = weekly(0.3, 3 * DAY);
    expect(balanceScore(value, 0, NOW)).toBeGreaterThan(
      balanceScore(value, 4, NOW),
    );
  });

  it("counts only working days left before a reset", () => {
    const overWeekend = weekly(0.5, 3 * DAY);
    expect(balanceScore(overWeekend, 0, NOW, WEEKDAYS)).toBeGreaterThan(
      balanceScore(overWeekend, 0, NOW),
    );
  });
});

describe("rankByBalance", () => {
  it("orders by score and keeps priority order for ties", () => {
    const ranked = rankByBalance(
      [
        candidate("first", quota()),
        candidate("second", quota()),
        candidate("third", weekly(0.2, 12 * HOUR)),
      ],
      () => 0,
      NOW,
    );
    expect(ids(ranked)).toEqual(["third", "first", "second"]);
  });
});

describe("gateMembership", () => {
  it("keeps reserve accounts out while a primary account is available", () => {
    const gated = gateMembership(
      [
        member("personal", "primary", quota()),
        member("work", "reserve", weekly(0.1, 4 * DAY)),
      ],
      NOW,
      DRAIN,
    );
    expect(ids(gated)).toEqual(["personal"]);
  });

  it("adds a reserve account inside its drain window while under its cap", () => {
    const gated = gateMembership(
      [
        member("personal", "primary", quota()),
        member("work", "reserve", weekly(0.7, 6 * HOUR)),
      ],
      NOW,
      DRAIN,
    );
    expect(ids(gated)).toEqual(["personal", "work"]);
  });

  it("falls back to reserve accounts under their progressive cap when no primary remains", () => {
    const gated = gateMembership(
      [
        member("work-idle", "reserve", weekly(0.1, 4 * DAY)),
        member("work-busy", "reserve", weekly(0.6, 4 * DAY)),
        member("work-tight", "reserve", weekly(0.1, 4 * DAY), {
          early: 0.05,
          late: 0.1,
        }),
      ],
      NOW,
      DRAIN,
    );
    expect(ids(gated)).toEqual(["work-idle"]);
  });

  it("raises a shared account's cap from early to late as the reset approaches", () => {
    const shared = { early: 0.15, late: 0.98 };
    const early = gateMembership(
      [
        member("family", "primary", weekly(0.3, 6 * DAY), shared),
        member("personal", "primary", weekly(0.2, 5 * DAY)),
      ],
      NOW,
      DRAIN,
    );
    expect(ids(early)).toEqual(["personal"]);
    const late = gateMembership(
      [
        member("family", "primary", weekly(0.3, DAY), shared),
        member("personal", "primary", weekly(0.2, 5 * DAY)),
      ],
      NOW,
      DRAIN,
    );
    expect(ids(late)).toEqual(["family", "personal"]);
  });

  it("holds a capped account to its early limit when the reset is unknown", () => {
    const gated = gateMembership(
      [
        member("family", "primary", weekly(0.2, null), {
          early: 0.15,
          late: 0.98,
        }),
        member("personal", "primary", quota()),
      ],
      NOW,
      DRAIN,
    );
    expect(ids(gated)).toEqual(["personal"]);
  });

  it("does not open the drain window for a weekly reset that already passed", () => {
    const gated = gateMembership(
      [
        member("personal", "primary", quota()),
        member("work", "reserve", weekly(0.9, -HOUR)),
      ],
      NOW,
      DRAIN,
    );
    expect(ids(gated)).toEqual(["personal"]);
  });

  it("raises the cap on Friday for a reset after the weekend", () => {
    const entries = [
      member("family", "primary", weekly(0.7, 3 * DAY), {
        early: 0.15,
        late: 0.98,
      }),
      member("personal", "primary", quota()),
    ];
    expect(ids(gateMembership(entries, NOW, DRAIN))).toEqual(["personal"]);
    expect(ids(gateMembership(entries, NOW, DRAIN, WEEKDAYS))).toEqual([
      "family",
      "personal",
    ]);
  });

  it("opens the drain window on Friday for a Monday reset", () => {
    const entries = [
      member("personal", "primary", quota()),
      member("work", "reserve", weekly(0.1, 3 * DAY)),
    ];
    expect(ids(gateMembership(entries, NOW, DRAIN))).toEqual(["personal"]);
    expect(ids(gateMembership(entries, NOW, DRAIN, WEEKDAYS))).toEqual([
      "personal",
      "work",
    ]);
  });
});
