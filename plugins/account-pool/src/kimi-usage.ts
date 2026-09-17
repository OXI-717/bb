import { z } from "zod";
import { EMPTY_FAMILY_WEEKLY, type AccountQuota } from "./contracts.js";
import { parseReset } from "./quota.js";

const amountSchema = z.union([z.number(), z.string()]).nullish();

const detailSchema = z
  .object({
    limit: amountSchema,
    used: amountSchema,
    remaining: amountSchema,
    resetTime: z.union([z.number(), z.string()]).nullish(),
    reset_at: z.union([z.number(), z.string()]).nullish(),
    resetAt: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const usagesPayloadSchema = z
  .object({
    usage: detailSchema.nullish(),
    limits: z
      .array(
        z
          .object({
            detail: detailSchema.nullish(),
            window: z
              .object({
                duration: z.union([z.number(), z.string()]).nullish(),
                timeUnit: z.string().nullish(),
              })
              .passthrough()
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

type Detail = z.infer<typeof detailSchema>;

function amount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function utilization(detail: Detail | null | undefined): number | null {
  if (detail === null || detail === undefined) return null;
  const limit = amount(detail.limit);
  if (limit === null || limit <= 0) return null;
  const used = amount(detail.used);
  if (used !== null) return Math.min(Math.max(used / limit, 0), 1);
  const remaining = amount(detail.remaining);
  if (remaining === null) return null;
  return Math.min(Math.max((limit - remaining) / limit, 0), 1);
}

function resetAt(detail: Detail | null | undefined): number | null {
  if (detail === null || detail === undefined) return null;
  const raw = detail.resetTime ?? detail.resetAt ?? detail.reset_at ?? null;
  return parseReset(raw);
}

function windowMinutes(
  duration: number | string | null | undefined,
  timeUnit: string | null | undefined,
): number | null {
  const value = amount(duration);
  if (value === null || value <= 0) return null;
  const unit = (timeUnit ?? "").toUpperCase();
  if (unit.includes("HOUR")) return value * 60;
  if (unit.includes("SECOND")) return value / 60;
  if (unit.includes("DAY")) return value * 1_440;
  return value;
}

export function kimiQuotaFromUsages(
  accountId: string,
  payload: unknown,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const parsed = usagesPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const weekly = parsed.data.usage ?? null;
  const rows = parsed.data.limits ?? [];
  let rolling: Detail | null = null;
  let rollingMinutes: number | null = null;
  for (const row of rows) {
    const minutes = windowMinutes(row.window?.duration, row.window?.timeUnit);
    if (minutes === null) continue;
    if (rollingMinutes !== null && minutes >= rollingMinutes) continue;
    rolling = row.detail ?? null;
    rollingMinutes = minutes;
  }
  const weeklyUtilization = utilization(weekly);
  const rollingUtilization = utilization(rolling);
  if (weeklyUtilization === null && rollingUtilization === null) return null;
  return {
    accountId,
    fiveHourUtilization: rollingUtilization,
    fiveHourResetAt: resetAt(rolling),
    fiveHourStatus: null,
    sevenDayUtilization: weeklyUtilization,
    sevenDayResetAt: resetAt(weekly),
    sevenDayStatus: null,
    representativeClaim: previous.representativeClaim,
    familyWeekly: EMPTY_FAMILY_WEEKLY,
    limitWindows:
      rollingUtilization === null || rollingMinutes === null
        ? []
        : [
            {
              slot: "primary",
              windowMinutes: Math.round(rollingMinutes),
              utilization: rollingUtilization,
              resetAt: resetAt(rolling),
              status: null,
              observedAt: now,
              source: "usage",
            },
          ],
    observedAt: now,
    heldUntil: previous.heldUntil,
    error: null,
  };
}
