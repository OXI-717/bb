import type { AccountQuota } from "./contracts.js";

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;
const MIN_REMAINING_MS = 15 * MINUTE_MS;
const SESSION_SOFT_CEILING = 0.8;
const IN_FLIGHT_WEIGHT = 0.25;
export const DEFAULT_RESERVE_CAP = 0.5;

interface QuotaWindow {
  utilization: number;
  resetAt: number | null;
  lengthMs: number;
}

interface PoolMembership {
  role: "primary" | "reserve";
  cap: number | null;
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
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

function weeklyUrgency(windows: QuotaWindow[], now: number): number {
  const weekly = weeklyWindow(windows);
  if (weekly === null) return 1;
  const remainingMs =
    weekly.resetAt === null
      ? weekly.lengthMs
      : Math.max(weekly.resetAt - now, MIN_REMAINING_MS);
  return (1 - weekly.utilization) / (remainingMs / weekly.lengthMs);
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
): number {
  const windows = quotaWindows(quota, now);
  return (
    (weeklyUrgency(windows, now) * sessionFactor(windows)) /
    (1 + IN_FLIGHT_WEIGHT * inFlight)
  );
}

export function rankByBalance<
  T extends { account: { id: string }; quota: AccountQuota },
>(
  candidates: readonly T[],
  inFlight: (accountId: string) => number,
  now: number,
): T[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: balanceScore(candidate.quota, inFlight(candidate.account.id), now),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function inDrainWindow(
  windows: QuotaWindow[],
  now: number,
  drainMs: number,
): boolean {
  const weekly = weeklyWindow(windows);
  return (
    weekly !== null && weekly.resetAt !== null && weekly.resetAt - now <= drainMs
  );
}

function effectiveCap(account: PoolMembership): number {
  return (
    account.cap ??
    (account.role === "reserve" ? DEFAULT_RESERVE_CAP : Number.POSITIVE_INFINITY)
  );
}

export function gateMembership<
  T extends { account: PoolMembership; quota: AccountQuota },
>(entries: readonly T[], now: number, drainMs: number): T[] {
  const assessed = entries.map((entry) => {
    const windows = quotaWindows(entry.quota, now);
    return {
      entry,
      draining: inDrainWindow(windows, now, drainMs),
      weeklyUtilization: weeklyWindow(windows)?.utilization ?? 0,
    };
  });
  const withinCap = assessed.filter(
    ({ entry, draining, weeklyUtilization }) =>
      draining || weeklyUtilization < effectiveCap(entry.account),
  );
  const preferred = withinCap.filter(
    ({ entry, draining }) => entry.account.role === "primary" || draining,
  );
  return (preferred.length > 0 ? preferred : withinCap).map(
    ({ entry }) => entry,
  );
}
