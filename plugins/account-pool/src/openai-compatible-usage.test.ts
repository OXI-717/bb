import { describe, expect, it } from "vitest";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import {
  opencodeGoQuotaFromUsages,
  zaiQuotaFromUsages,
} from "./openai-compatible-usage.js";

const ACCOUNT_ID = "3f2c0b74-91aa-4c2e-8a1e-7b6d5c4e3a22";
const NOW = Date.parse("2026-09-17T09:00:00.000Z");

function previous(): AccountQuota {
  return {
    accountId: ACCOUNT_ID,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: null,
    heldUntil: null,
    error: "stale failure",
  };
}

describe("z.ai quota parsing", () => {
  it("classifies the token windows by unit, not by reset order", () => {
    const quota = zaiQuotaFromUsages(
      ACCOUNT_ID,
      {
        code: 200,
        data: {
          level: "lite",
          limits: [
            { type: "TIME_LIMIT", unit: 5, percentage: 90 },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              percentage: 63,
              nextResetTime: 1789648864022,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              percentage: 12,
              nextResetTime: 1789869700999,
            },
          ],
        },
      },
      previous(),
      NOW,
    );
    expect(quota).toMatchObject({
      fiveHourUtilization: 0.12,
      fiveHourResetAt: 1789869700999,
      sevenDayUtilization: 0.63,
      sevenDayResetAt: 1789648864022,
      observedAt: NOW,
      error: null,
    });
  });

  it("ignores non-token windows and reports nothing without them", () => {
    expect(
      zaiQuotaFromUsages(
        ACCOUNT_ID,
        { data: { limits: [{ type: "TIME_LIMIT", unit: 5, percentage: 40 }] } },
        previous(),
        NOW,
      ),
    ).toBe(null);
  });
});

describe("OpenCode Go quota parsing", () => {
  it("reads the rolling and weekly windows from a live payload", () => {
    const quota = opencodeGoQuotaFromUsages(
      ACCOUNT_ID,
      {
        usage: {
          rolling: {
            status: "ok",
            percent: 4,
            resetsAt: "2026-09-17T14:53:00.430Z",
          },
          weekly: {
            status: "ok",
            percent: 72,
            resetsAt: "2026-09-21T00:00:00.430Z",
          },
          monthly: { status: "ok", percent: 37 },
        },
      },
      previous(),
      NOW,
    );
    expect(quota).toMatchObject({
      fiveHourUtilization: 0.04,
      fiveHourResetAt: Date.parse("2026-09-17T14:53:00.430Z"),
      sevenDayUtilization: 0.72,
      sevenDayResetAt: Date.parse("2026-09-21T00:00:00.430Z"),
      error: null,
    });
  });

  it("reports nothing when the payload carries no windows", () => {
    expect(
      opencodeGoQuotaFromUsages(ACCOUNT_ID, { usage: {} }, previous(), NOW),
    ).toBe(null);
    expect(
      opencodeGoQuotaFromUsages(ACCOUNT_ID, "not json", previous(), NOW),
    ).toBe(null);
  });
});
