import { dayEndMs } from "./trendData";
import {
  CombinedAccountRow,
  DailyBucket,
  UsageEvent,
  UsageSnapshot,
  accountLabelFor,
} from "./models";

export const PER_ACCOUNT_TREND_EVENTS = 50;
export const MAX_COMBINED_EVENTS = 1000;

export type AccountSortBy = "activity" | "tokens";

/** PollingInterval seconds → stale threshold (same as cached badge: ×3). */
export function staleThresholdFromPollingInterval(pollingIntervalSeconds: number): number {
  return Math.max(5, pollingIntervalSeconds) * 3 * 1000;
}

export function isAccountStale(
  updatedAt: string,
  opts: {
    currentUserId?: string | null;
    accountUserId?: string;
    nowMs?: number;
    staleMs: number;
  },
): boolean {
  if (opts.accountUserId && opts.currentUserId && opts.accountUserId === opts.currentUserId) {
    return false;
  }
  return (opts.nowMs ?? Date.now()) - Date.parse(updatedAt) > opts.staleMs;
}

/** Whether a secondary JWT should be refreshed (aligned with cached badge). */
export function shouldRefreshSecondary(
  lastFetchedAtIso: string | null | undefined,
  nowMs: number,
  staleMs: number,
): boolean {
  if (!lastFetchedAtIso) return true;
  const t = Date.parse(lastFetchedAtIso);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= staleMs;
}

/**
 * Latest billed usage moment from the full account snapshot (not a range slice).
 * Buckets contribute local day-end ms only.
 */
export function lastActivityMs(snapshot: {
  events: UsageEvent[];
  dailyBuckets?: DailyBucket[];
}): number | null {
  let max = 0;
  for (const e of snapshot.events) {
    const ts = e.timestamp > 0 && e.timestamp < 1e12 ? e.timestamp * 1000 : e.timestamp;
    if (ts > max) max = ts;
  }
  for (const b of snapshot.dailyBuckets ?? []) {
    if ((b.totalTokens ?? 0) <= 0 && (b.requestCount ?? 0) <= 0) continue;
    const end = dayEndMs(b.day);
    if (end > max) max = end;
  }
  return max > 0 ? max : null;
}

export type RowMetrics = {
  totalTokens: number;
  cacheHitRate: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Single builder for overview rows (cycle + range). lastActivity always from full account. */
export function buildPerAccountRow(
  account: UsageSnapshot,
  metrics: RowMetrics,
  opts: { currentUserId?: string | null; nowMs?: number; staleMs: number },
): CombinedAccountRow {
  const updatedAt = account.timestamp.toISOString();
  const activityMs = lastActivityMs(account);
  const currentUserId = opts.currentUserId ?? null;
  return {
    userId: account.userId,
    label: accountLabelFor(account.userId, account.accountLabel),
    membershipType: account.membershipType,
    totalTokens: metrics.totalTokens,
    cursorModelsPercent: account.cursorModelsPercent,
    otherModelsPercent: account.otherModelsPercent,
    overallUsedCents: account.overallUsedCents,
    overallLimitCents: account.overallLimitCents,
    requestUsed: account.requestUsed ?? null,
    requestMax: account.requestMax ?? null,
    cacheHitRate: metrics.cacheHitRate,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    isStale: isAccountStale(updatedAt, {
      currentUserId,
      accountUserId: account.userId,
      nowMs: opts.nowMs,
      staleMs: opts.staleMs,
    }),
    isCurrent: !!(currentUserId && account.userId === currentUserId),
    updatedAt,
    lastActivityAt: activityMs != null ? new Date(activityMs).toISOString() : null,
  };
}

export function sortCombinedAccountRows(
  rows: CombinedAccountRow[],
  opts?: { by?: AccountSortBy },
): CombinedAccountRow[] {
  const by = opts?.by ?? "activity";
  return [...rows].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (by === "tokens" && a.totalTokens !== b.totalTokens) {
      return b.totalTokens - a.totalTokens;
    }
    if (by === "activity") {
      const am = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
      const bm = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
      if (am !== bm) return bm - am;
    } else if (a.totalTokens !== b.totalTokens) {
      return b.totalTokens - a.totalTokens;
    }
    return a.userId.localeCompare(b.userId);
  });
}

export function sumEventCostCents(accounts: UsageSnapshot[]): number {
  return accounts.reduce((sum, a) => {
    const fromEvents = a.events.reduce((s, e) => s + (e.totalCents || 0), 0);
    const fromBuckets = (a.dailyBuckets ?? []).reduce((s, b) => s + (b.totalCents || 0), 0);
    return sum + fromEvents + fromBuckets;
  }, 0);
}

export function mergeCombinedEvents(accounts: UsageSnapshot[]): UsageEvent[] {
  const seen = new Set<string>();
  const allEvents: UsageEvent[] = [];
  for (const a of accounts) {
    for (const e of a.events.slice(0, PER_ACCOUNT_TREND_EVENTS)) {
      const k = `${a.userId}|${e.timestamp}|${e.model}|${e.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      allEvents.push(e);
    }
  }
  return allEvents.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_COMBINED_EVENTS);
}
