import type { AccountQuota } from "./contracts.js";

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;
const MIN_REMAINING_MS = 15 * MINUTE_MS;
const SESSION_SOFT_CEILING = 0.8;
const IN_FLIGHT_WEIGHT = 0.25;
export const DEFAULT_RESERVE_CAP = { early: 0.15, late: 0.98 };

export interface WorkWeek {
  restDays: readonly number[];
  offsetMinutes: number;
}

export const CALENDAR_WEEK: WorkWeek = { restDays: [], offsetMinutes: 0 };

interface QuotaWindow {
  utilization: number;
  resetAt: number | null;
  lengthMs: number;
}

interface ProgressiveCap {
  early: number;
  late: number;
}

interface PoolMembership {
  role: "primary" | "reserve";
  cap: ProgressiveCap | null;
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function workingMs(from: number, to: number, week: WorkWeek): number {
  if (to <= from) return 0;
  if (week.restDays.length === 0) return to - from;
  const offset = week.offsetMinutes * MINUTE_MS;
  let total = 0;
  let cursor = from;
  while (cursor < to) {
    const local = cursor + offset;
    const end = Math.min(
      Math.floor(local / DAY_MS) * DAY_MS + DAY_MS - offset,
      to,
    );
    if (!week.restDays.includes(new Date(local).getUTCDay()))
      total += end - cursor;
    cursor = end;
  }
  return total;
}

function remainingWorkMs(
  window: QuotaWindow,
  now: number,
  week: WorkWeek,
): number | null {
  if (window.resetAt === null) return null;
  return workingMs(
    Math.max(now, window.resetAt - window.lengthMs),
    window.resetAt,
    week,
  );
}

function remainingShare(
  window: QuotaWindow,
  now: number,
  week: WorkWeek,
): number | null {
  if (window.resetAt === null) return null;
  const total = workingMs(
    window.resetAt - window.lengthMs,
    window.resetAt,
    week,
  );
  if (total === 0)
    return clampFraction((window.resetAt - now) / window.lengthMs);
  return clampFraction((remainingWorkMs(window, now, week) ?? 0) / total);
}

function quotaWindows(quota: AccountQuota, now: number): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const include = (
    utilization: number | null,
    resetAt: number | null,
    lengthMs: number,
  ) => {
    if (utilization === null) return;
    if (resetAt !== null && resetAt <= now) return;
    windows.push({ utilization: clampFraction(utilization), resetAt, lengthMs });
  };
  include(quota.fiveHourUtilization, quota.fiveHourResetAt, 5 * 60 * MINUTE_MS);
  include(quota.sevenDayUtilization, quota.sevenDayResetAt, WEEK_MS);
  for (const window of quota.limitWindows) {
    if (window.windowMinutes === null) continue;
    include(
      window.utilization,
      window.resetAt,
      window.windowMinutes * MINUTE_MS,
    );
  }
  return windows;
}

function busiest(windows: QuotaWindow[]): QuotaWindow | null {
  let result: QuotaWindow | null = null;
  for (const window of windows) {
    if (result === null || window.utilization > result.utilization)
      result = window;
  }
  return result;
}

function weeklyWindow(windows: QuotaWindow[]): QuotaWindow | null {
  return busiest(windows.filter((window) => window.lengthMs >= DAY_MS));
}

function weeklyUrgency(
  windows: QuotaWindow[],
  now: number,
  week: WorkWeek,
): number {
  const weekly = weeklyWindow(windows);
  if (weekly === null) return 1;
  const share = remainingShare(weekly, now, week) ?? 1;
  return (
    (1 - weekly.utilization) /
    Math.max(share, MIN_REMAINING_MS / weekly.lengthMs)
  );
}

function sessionFactor(windows: QuotaWindow[]): number {
  const session = busiest(
    windows.filter((window) => window.lengthMs < DAY_MS),
  );
  if (session === null || session.utilization < SESSION_SOFT_CEILING) return 1;
  return (1 - session.utilization) / (1 - SESSION_SOFT_CEILING);
}

export function balanceScore(
  quota: AccountQuota,
  inFlight: number,
  now: number,
  week: WorkWeek = CALENDAR_WEEK,
): number {
  const windows = quotaWindows(quota, now);
  return (
    (weeklyUrgency(windows, now, week) * sessionFactor(windows)) /
    (1 + IN_FLIGHT_WEIGHT * inFlight)
  );
}

export function rankByBalance<
  T extends { account: { id: string }; quota: AccountQuota },
>(
  candidates: readonly T[],
  inFlight: (accountId: string) => number,
  now: number,
  week: WorkWeek = CALENDAR_WEEK,
): T[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: balanceScore(
        candidate.quota,
        inFlight(candidate.account.id),
        now,
        week,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function allowedUtilization(
  cap: ProgressiveCap,
  weekly: QuotaWindow | null,
  now: number,
  week: WorkWeek,
): number {
  const share = weekly === null ? null : remainingShare(weekly, now, week);
  if (share === null) return cap.early;
  return cap.late - (cap.late - cap.early) * share;
}

function effectiveCap(account: PoolMembership): ProgressiveCap | null {
  return (
    account.cap ?? (account.role === "reserve" ? DEFAULT_RESERVE_CAP : null)
  );
}

export function capLimit(
  account: PoolMembership,
  quota: AccountQuota,
  now: number,
  week: WorkWeek = CALENDAR_WEEK,
): number | null {
  const cap = effectiveCap(account);
  if (cap === null) return null;
  return allowedUtilization(
    cap,
    weeklyWindow(quotaWindows(quota, now)),
    now,
    week,
  );
}

export function gateMembership<
  T extends { account: PoolMembership; quota: AccountQuota },
>(
  entries: readonly T[],
  now: number,
  drainMs: number,
  week: WorkWeek = CALENDAR_WEEK,
): T[] {
  const assessed = entries.map((entry) => {
    const weekly = weeklyWindow(quotaWindows(entry.quota, now));
    const left = weekly === null ? null : remainingWorkMs(weekly, now, week);
    return { entry, weekly, draining: left !== null && left <= drainMs };
  });
  const withinCap = assessed.filter(({ entry, weekly }) => {
    const cap = effectiveCap(entry.account);
    return (
      cap === null ||
      (weekly?.utilization ?? 0) < allowedUtilization(cap, weekly, now, week)
    );
  });
  const preferred = withinCap.filter(
    ({ entry, draining }) => entry.account.role === "primary" || draining,
  );
  return (preferred.length > 0 ? preferred : withinCap).map(
    ({ entry }) => entry,
  );
}
