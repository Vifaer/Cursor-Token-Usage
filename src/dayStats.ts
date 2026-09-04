import { computeCacheStatsFromAggs, computeCacheStatsFromEvents } from "./cacheStats";
import { mergeCombinedEvents, sortCombinedAccountRows } from "./combinedView";
import { todayLocal } from "./dailyBuckets";
import {
  CombinedViewDto,
  DailyBucket,
  ModelAgg,
  PanelData,
  StatsRange,
  UsageEvent,
  UsageSnapshot,
  accountLabelFor,
  isCombinedView,
} from "./models";
import { addDaysIso, dayKeyFromTs, sumUsageCostCents } from "./trendData";

export interface SlicedSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  aggregations: ModelAgg[];
  events: UsageEvent[];
  eventCostCents: number;
  dailyBuckets: DailyBucket[];
  cacheHitRate: number | null;
}

function mergeAggs(rows: ModelAgg[]): ModelAgg[] {
  const map = new Map<string, ModelAgg>();
  for (const a of rows) {
    const prev = map.get(a.model);
    if (!prev) {
      map.set(a.model, { ...a });
      continue;
    }
    prev.inputTokens += a.inputTokens;
    prev.outputTokens += a.outputTokens;
    prev.cacheWriteTokens += a.cacheWriteTokens;
    prev.cacheReadTokens += a.cacheReadTokens;
    prev.totalTokens += a.totalTokens;
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function addEventToAggs(map: Map<string, ModelAgg>, e: UsageEvent): void {
  const prev = map.get(e.model);
  if (prev) {
    prev.inputTokens += e.inputTokens;
    prev.outputTokens += e.outputTokens;
    prev.cacheWriteTokens += e.cacheWriteTokens;
    prev.cacheReadTokens += e.cacheReadTokens;
    prev.totalTokens += e.totalTokens;
  } else {
    map.set(e.model, {
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      cacheReadTokens: e.cacheReadTokens,
      totalTokens: e.totalTokens,
    });
  }
}

function inRange(day: string, from: string, to: string): boolean {
  return day >= from && day <= to;
}

function staleThresholdMs(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require("vscode") as typeof import("vscode");
    const seconds = vscode.workspace.getConfiguration("cursorTokenUsage").get<number>("pollingInterval", 30);
    return Math.max(5, seconds) * 3 * 1000;
  } catch {
    return 90_000;
  }
}

function l10n(key: string, ...args: (string | number)[]): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require("vscode") as typeof import("vscode");
    if (args.length === 0) return vscode.l10n.t(key);
    return vscode.l10n.t(key, ...args.map(String));
  } catch {
    let out = key;
    args.forEach((a, i) => {
      out = out.replace(`{${i}}`, String(a));
    });
    return out;
  }
}

function isAccountStale(updatedAt: string, currentUserId?: string, accountUserId?: string): boolean {
  if (accountUserId && currentUserId && accountUserId === currentUserId) return false;
  return Date.now() - Date.parse(updatedAt) > staleThresholdMs();
}

export function resolveStatsRange(range: StatsRange, nowMs = Date.now()): StatsRange & { from: string; to: string } {
  const today = dayKeyFromTs(nowMs);
  if (range.mode === "cycle") {
    return { mode: "cycle", from: "", to: "" };
  }
  if (range.mode === "today") {
    return { mode: "today", from: today, to: today };
  }
  if (range.mode === "yesterday") {
    const y = addDaysIso(today, -1);
    return { mode: "yesterday", from: y, to: y };
  }
  if (range.mode === "7d") {
    return { mode: "7d", from: addDaysIso(today, -6), to: today };
  }
  let from = range.from ?? addDaysIso(today, -6);
  let to = range.to ?? today;
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  return { mode: "custom", from, to };
}

export function snapshotRangeSlice(
  snapshot: UsageSnapshot,
  from: string,
  to: string,
  today = todayLocal(),
): SlicedSnapshot {
  const buckets = (snapshot.dailyBuckets ?? []).filter(
    (b) => inRange(b.day, from, to) && b.day !== today,
  );
  const bucketDays = new Set(buckets.map((b) => b.day));
  // Past days with a bucket: use bucket only. Events fill today + days without buckets.
  const events = snapshot.events.filter((e) => {
    const day = dayKeyFromTs(e.timestamp);
    if (!inRange(day, from, to)) return false;
    if (day === today) return true;
    return !bucketDays.has(day);
  });

  const aggMap = new Map<string, ModelAgg>();
  for (const b of buckets) {
    for (const m of b.byModel) {
      const prev = aggMap.get(m.model);
      if (prev) {
        prev.inputTokens += m.inputTokens;
        prev.outputTokens += m.outputTokens;
        prev.cacheWriteTokens += m.cacheWriteTokens;
        prev.cacheReadTokens += m.cacheReadTokens;
        prev.totalTokens += m.totalTokens;
      } else {
        aggMap.set(m.model, { ...m });
      }
    }
  }
  for (const e of events) {
    addEventToAggs(aggMap, e);
  }
  const aggregations = [...aggMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);

  let totalTokens = buckets.reduce((s, b) => s + b.totalTokens, 0);
  totalTokens += events.reduce((s, e) => s + e.totalTokens, 0);

  const cache =
    aggregations.length > 0
      ? computeCacheStatsFromAggs(aggregations)
      : computeCacheStatsFromEvents(events);

  const trendBuckets = buckets;
  const eventCostCents = sumUsageCostCents(events, trendBuckets);

  return {
    totalTokens,
    inputTokens: cache.inputTokens,
    outputTokens: cache.outputTokens,
    cacheReadTokens: cache.cacheReadTokens,
    cacheWriteTokens: cache.cacheWriteTokens,
    aggregations,
    events,
    eventCostCents,
    dailyBuckets: trendBuckets,
    cacheHitRate: cache.hitRate,
  };
}

export function buildCombinedViewForRange(
  accounts: UsageSnapshot[],
  from: string,
  to: string,
  currentUserId?: string,
): CombinedViewDto | null {
  if (accounts.length === 0) return null;

  const slices = accounts.map((a) => ({ account: a, slice: snapshotRangeSlice(a, from, to) }));

  const perAccountRows = slices.map(({ account, slice }) => {
    const updatedAt = account.timestamp.toISOString();
    return {
      userId: account.userId,
      label: accountLabelFor(account.userId, account.accountLabel),
      membershipType: account.membershipType,
      totalTokens: slice.totalTokens,
      cursorModelsPercent: account.cursorModelsPercent,
      otherModelsPercent: account.otherModelsPercent,
      overallUsedCents: account.overallUsedCents,
      overallLimitCents: account.overallLimitCents,
      requestUsed: account.requestUsed ?? null,
      requestMax: account.requestMax ?? null,
      cacheHitRate: slice.cacheHitRate,
      cacheReadTokens: slice.cacheReadTokens,
      cacheWriteTokens: slice.cacheWriteTokens,
      isStale: isAccountStale(updatedAt, currentUserId, account.userId),
      updatedAt,
    };
  });

  let totalTokens = 0;
  let overallUsedCents: number | null = null;
  let overallLimitCents: number | null = null;
  let onDemandUsedCents: number | null = null;
  const allAggs: ModelAgg[] = [];

  for (const { account, slice } of slices) {
    totalTokens += slice.totalTokens;
    if (account.overallUsedCents !== null) overallUsedCents = (overallUsedCents ?? 0) + account.overallUsedCents;
    if (account.overallLimitCents !== null) overallLimitCents = (overallLimitCents ?? 0) + account.overallLimitCents;
    if (account.onDemandUsedCents !== null) onDemandUsedCents = (onDemandUsedCents ?? 0) + account.onDemandUsedCents;
    allAggs.push(...slice.aggregations);
  }

  const slicedAccounts: UsageSnapshot[] = slices.map(({ account, slice }) => ({
    ...account,
    totalTokens: slice.totalTokens,
    aggregations: slice.aggregations,
    events: slice.events,
    dailyBuckets: slice.dailyBuckets,
  }));

  const events = mergeCombinedEvents(slicedAccounts);
  const aggregations = mergeAggs(allAggs);
  const cache =
    aggregations.length > 0
      ? computeCacheStatsFromAggs(aggregations)
      : computeCacheStatsFromEvents(events);
  const eventCostCents = slices.reduce((s, { slice }) => s + slice.eventCostCents, 0);
  const eventsComplete = accounts.every((a) => a.eventsComplete);

  return {
    kind: "combined",
    accountLabel: l10n("All accounts ({0})", accounts.length),
    totalTokens,
    overallUsedCents,
    overallLimitCents,
    onDemandUsedCents,
    billingCycleNote: l10n("Billing cycles may differ per account"),
    perAccountRows: sortCombinedAccountRows(perAccountRows, { by: "tokens", preferFresh: false }),
    events,
    aggregations,
    membershipType: "combined",
    billingCycleEnd: "",
    cacheHitRate: cache.hitRate,
    cacheReadTokens: cache.cacheReadTokens,
    cacheWriteTokens: cache.cacheWriteTokens,
    inputTokens: cache.inputTokens,
    outputTokens: cache.outputTokens,
    eventCostCents,
    eventsComplete,
  };
}

export function applyStatsRange(
  data: PanelData | null,
  accounts: UsageSnapshot[],
  range: StatsRange,
  currentUserId?: string,
): PanelData | null {
  if (!data) return null;
  if (range.mode === "cycle") return data;

  const resolved = resolveStatsRange(range);
  if (!resolved.from || !resolved.to) return data;

  if (isCombinedView(data)) {
    return buildCombinedViewForRange(accounts, resolved.from, resolved.to, currentUserId);
  }

  const slice = snapshotRangeSlice(data, resolved.from, resolved.to);
  return {
    ...data,
    totalTokens: slice.totalTokens,
    aggregations: slice.aggregations,
    events: slice.events,
    dailyBuckets: slice.dailyBuckets,
  };
}
