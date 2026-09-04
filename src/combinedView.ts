import { CombinedAccountRow, UsageEvent, UsageSnapshot } from "./models";

export const PER_ACCOUNT_TREND_EVENTS = 50;
export const MAX_COMBINED_EVENTS = 1000;

export type AccountSortBy = "updated" | "tokens";

export function sortCombinedAccountRows(
  rows: CombinedAccountRow[],
  opts?: { by?: AccountSortBy; preferFresh?: boolean },
): CombinedAccountRow[] {
  const by = opts?.by ?? "updated";
  // Token sort: never bury non-zero rows under fresh zeros (range overview).
  const preferFresh = opts?.preferFresh ?? by === "updated";
  return [...rows].sort((a, b) => {
    if (preferFresh && a.isStale !== b.isStale) return a.isStale ? 1 : -1;
    if (by === "tokens" && a.totalTokens !== b.totalTokens) {
      return b.totalTokens - a.totalTokens;
    }
    if (by === "updated") return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return b.totalTokens - a.totalTokens;
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
