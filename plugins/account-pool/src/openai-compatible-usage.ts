import { z } from "zod";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import { parseReset } from "./quota.js";

const ZAI_FIVE_HOUR_UNIT = 3;
const ZAI_WEEKLY_UNIT = 6;

const zaiWindowSchema = z
  .object({
    type: z.string().nullish(),
    unit: z.number().nullish(),
    percentage: z.union([z.number(), z.string()]).nullish(),
    nextResetTime: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const zaiPayloadSchema = z
  .object({
    data: z
      .object({ limits: z.array(zaiWindowSchema).nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const percentWindowSchema = z
  .object({
    percent: z.union([z.number(), z.string()]).nullish(),
    resetsAt: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const opencodeGoPayloadSchema = z
  .object({
    usage: z
      .object({
        rolling: percentWindowSchema.nullish(),
        weekly: percentWindowSchema.nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

function fraction(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed / 100, 0), 1);
}

function quota(
  accountId: string,
  previous: AccountQuota,
  now: number,
  windows: {
    fiveHour: { utilization: number | null; resetAt: number | null };
    weekly: { utilization: number | null; resetAt: number | null };
  },
): AccountQuota | null {
  if (
    windows.fiveHour.utilization === null &&
    windows.weekly.utilization === null
  ) {
    return null;
  }
  return {
    accountId,
    fiveHourUtilization: windows.fiveHour.utilization,
    fiveHourResetAt: windows.fiveHour.resetAt,
    fiveHourStatus: null,
    sevenDayUtilization: windows.weekly.utilization,
    sevenDayResetAt: windows.weekly.resetAt,
    sevenDayStatus: null,
    representativeClaim: previous.representativeClaim,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows: [],
    observedAt: now,
    heldUntil: previous.heldUntil,
    error: null,
  };
}

export function zaiQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const parsed = zaiPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const windows = (parsed.data.data?.limits ?? []).filter(
    (row) => row.type === "TOKENS_LIMIT",
  );
  const byUnit = (unit: number) =>
    windows.find((row) => row.unit === unit) ?? null;
  const fiveHour = byUnit(ZAI_FIVE_HOUR_UNIT);
  const weekly = byUnit(ZAI_WEEKLY_UNIT);
  return quota(accountId, previous, now, {
    fiveHour: {
      utilization: fraction(fiveHour?.percentage),
      resetAt: parseReset(fiveHour?.nextResetTime ?? null),
    },
    weekly: {
      utilization: fraction(weekly?.percentage),
      resetAt: parseReset(weekly?.nextResetTime ?? null),
    },
  });
}

export function opencodeGoQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const parsed = opencodeGoPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const rolling = parsed.data.usage?.rolling ?? null;
  const weekly = parsed.data.usage?.weekly ?? null;
  return quota(accountId, previous, now, {
    fiveHour: {
      utilization: fraction(rolling?.percent),
      resetAt: parseReset(rolling?.resetsAt ?? null),
    },
    weekly: {
      utilization: fraction(weekly?.percent),
      resetAt: parseReset(weekly?.resetsAt ?? null),
    },
  });
}
