import { describe, expect, it } from "vitest";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import { kimiQuotaFromUsages } from "./kimi-usage.js";

const ACCOUNT_ID = "9f1d7d44-0b8f-4f07-9f1c-2c3f0d5ab111";
const NOW = Date.parse("2026-09-17T08:00:00.000Z");

function previous(): AccountQuota {
  return {
    accountId: ACCOUNT_ID,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: "claim-one",
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: null,
    heldUntil: 1234,
    error: "stale failure",
  };
}

describe("Kimi usages parsing", () => {
  it("reads the weekly and rolling windows from a live payload", () => {
    const quota = kimiQuotaFromUsages(
      ACCOUNT_ID,
      {
        usage: {
          limit: "100",
          used: "45",
          remaining: "55",
          resetTime: "2026-09-19T15:51:15.390268Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "100",
              used: "26",
              remaining: "74",
              resetTime: "2026-09-17T08:51:15.390268Z",
            },
          },
        ],
        booster_wallet: { status: "STATUS_DISABLED" },
      },
      previous(),
      NOW,
    );
    expect(quota).toMatchObject({
      accountId: ACCOUNT_ID,
      sevenDayUtilization: 0.45,
      sevenDayResetAt: Date.parse("2026-09-19T15:51:15.390Z"),
      fiveHourUtilization: 0.26,
      fiveHourResetAt: Date.parse("2026-09-17T08:51:15.390Z"),
      observedAt: NOW,
      error: null,
      heldUntil: 1234,
      representativeClaim: "claim-one",
    });
    expect(quota?.limitWindows).toEqual([
      {
        slot: "primary",
        windowMinutes: 300,
        utilization: 0.26,
        resetAt: Date.parse("2026-09-17T08:51:15.390Z"),
        status: null,
        observedAt: NOW,
        source: "usage",
      },
    ]);
  });

  it("derives utilization from remaining when the payload omits used", () => {
    const quota = kimiQuotaFromUsages(
      ACCOUNT_ID,
      {
        usage: { limit: "100", remaining: "20" },
        limits: [
          {
            window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
            detail: { limit: "100", remaining: "100" },
          },
        ],
      },
      previous(),
      NOW,
    );
    expect(quota?.sevenDayUtilization).toBe(0.8);
    expect(quota?.fiveHourUtilization).toBe(0);
    expect(quota?.limitWindows[0]?.windowMinutes).toBe(300);
  });

  it("keeps a fresh window that carries no quota fields out of the report", () => {
    const quota = kimiQuotaFromUsages(
      ACCOUNT_ID,
      {
        usage: { limit: "100", used: "10" },
        limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } }],
      },
      previous(),
      NOW,
    );
    expect(quota?.sevenDayUtilization).toBe(0.1);
    expect(quota?.fiveHourUtilization).toBeNull();
    expect(quota?.limitWindows).toEqual([]);
  });

  it("reports nothing when the payload carries no usable quota", () => {
    expect(kimiQuotaFromUsages(ACCOUNT_ID, { usage: {} }, previous(), NOW)).toBe(
      null,
    );
    expect(kimiQuotaFromUsages(ACCOUNT_ID, "not json", previous(), NOW)).toBe(
      null,
    );
  });
});
