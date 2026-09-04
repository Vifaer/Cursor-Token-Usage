import * as vscode from "vscode";
import { computeCacheStats } from "./cacheStats";
import { mergeCombinedEvents, sortCombinedAccountRows, sumEventCostCents } from "./combinedView";
import { mergeEvents } from "./mergeEvents";
import { compactEvents, MAX_EVENTS_PER_ACCOUNT, normalizeEventTimestamps, shouldCompact } from "./dailyBuckets";
import {
  CombinedAccountRow,
  CombinedViewDto,
  DailyBucket,
  ModelAgg,
  UsageEvent,
  UsageSnapshot,
  accountLabelFor,
} from "./models";

export { compactEvents } from "./dailyBuckets";
export { mergeCombinedEvents, sortCombinedAccountRows } from "./combinedView";

const STORE_KEY = "cursorTokenUsage.accounts.v1";
const VIEW_SCOPE_KEY = "cursorTokenUsage.viewScope.v1";
/** One-shot: wipe additive-corrupt dailyBuckets so query/full poll can reseal cleanly. */
const DAY_BUCKET_RESET_KEY = "cursorTokenUsage.dayBuckets.reset.v1";

interface PersistedSnapshot {
  userId: string;
  accountLabel?: string;
  membershipType: string;
  billingCycleStart: string;
  billingCycleEnd: string;
  isUnlimited: boolean;
  displayMode: UsageSnapshot["displayMode"];
  cursorModelsPercent: number | null;
  otherModelsPercent: number | null;
  totalPercent: number | null;
  overallUsedCents: number | null;
  overallLimitCents: number | null;
  onDemandEnabled: boolean;
  onDemandUsedCents: number | null;
  onDemandLimitCents: number | null;
  requestUsed: number | null;
  requestMax: number | null;
  planName: string;
  aggregations: ModelAgg[];
  events: UsageEvent[];
  eventsComplete: boolean;
  totalTokens: number;
  dailyBuckets?: DailyBucket[];
  updatedAt: string;
}

let globalState: vscode.Memento | undefined;

export function initStore(context: vscode.ExtensionContext): void {
  globalState = context.globalState;
}

/**
 * Clear all dailyBuckets once (schema fix for additive compact corruption).
 * Keeps events/aggregations; next full poll or date Query reseals days correctly.
 */
export async function resetCorruptedDayBucketsOnce(): Promise<number> {
  if (!globalState) return 0;
  if (globalState.get<boolean>(DAY_BUCKET_RESET_KEY)) return 0;
  const all = readAll();
  let cleared = 0;
  for (const snap of Object.values(all)) {
    if ((snap.dailyBuckets?.length ?? 0) > 0) {
      snap.dailyBuckets = [];
      cleared++;
    }
  }
  if (cleared > 0) await writeAll(all);
  await globalState.update(DAY_BUCKET_RESET_KEY, true);
  return cleared;
}

export async function saveViewScope(scope: import("./models").ViewScope, accountId?: string | null): Promise<void> {
  await globalState?.update(VIEW_SCOPE_KEY, scope === "account" ? `account:${accountId ?? ""}` : scope);
}

export function parseSavedViewScope(): { scope: import("./models").ViewScope; accountId: string | null } {
  const saved = globalState?.get<string>(VIEW_SCOPE_KEY);
  if (saved === "current" || saved === "all") return { scope: saved, accountId: null };
  if (saved?.startsWith("account:")) {
    const accountId = saved.slice("account:".length);
    return accountId ? { scope: "account", accountId } : { scope: "all", accountId: null };
  }
  return { scope: "all", accountId: null };
}

function staleThresholdMs(): number {
  const seconds = vscode.workspace.getConfiguration("cursorTokenUsage").get<number>("pollingInterval", 30);
  return Math.max(5, seconds) * 3 * 1000;
}

function isAccountStale(updatedAt: string, currentUserId?: string, accountUserId?: string): boolean {
  if (accountUserId && currentUserId && accountUserId === currentUserId) return false;
  return Date.now() - Date.parse(updatedAt) > staleThresholdMs();
}

function readAll(): Record<string, PersistedSnapshot> {
  return globalState?.get<Record<string, PersistedSnapshot>>(STORE_KEY, {}) ?? {};
}

async function writeAll(data: Record<string, PersistedSnapshot>): Promise<void> {
  await globalState?.update(STORE_KEY, data);
}

function maxStoredAccountsLimit(): number {
  return vscode.workspace.getConfiguration("cursorTokenUsage").get<number>("maxStoredAccounts", 0);
}

function pruneAccounts(all: Record<string, PersistedSnapshot>): void {
  const limit = maxStoredAccountsLimit();
  if (limit <= 0) return;
  const entries = Object.values(all).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (entries.length <= limit) return;
  const pruned = entries.length - limit;
  for (const drop of entries.slice(limit)) {
    delete all[drop.userId];
  }
  console.log(`[cursor-token-usage] pruned ${pruned} accounts (limit=${limit})`);
}

function toPersisted(snapshot: UsageSnapshot): PersistedSnapshot {
  let events = normalizeEventTimestamps(snapshot.events);
  let dailyBuckets = snapshot.dailyBuckets ?? [];
  if (shouldCompact(events, dailyBuckets)) {
    const compacted = compactEvents(events, dailyBuckets);
    events = compacted.events;
    dailyBuckets = compacted.dailyBuckets;
  } else {
    events = events.slice(0, MAX_EVENTS_PER_ACCOUNT);
    dailyBuckets = dailyBuckets.filter((b) => b.day >= "2020-01-01");
  }

  return {
    userId: snapshot.userId,
    accountLabel: snapshot.accountLabel,
    membershipType: snapshot.membershipType,
    billingCycleStart: snapshot.billingCycleStart,
    billingCycleEnd: snapshot.billingCycleEnd,
    isUnlimited: snapshot.isUnlimited,
    displayMode: snapshot.displayMode,
    cursorModelsPercent: snapshot.cursorModelsPercent,
    otherModelsPercent: snapshot.otherModelsPercent,
    totalPercent: snapshot.totalPercent,
    overallUsedCents: snapshot.overallUsedCents,
    overallLimitCents: snapshot.overallLimitCents,
    onDemandEnabled: snapshot.onDemandEnabled,
    onDemandUsedCents: snapshot.onDemandUsedCents,
    onDemandLimitCents: snapshot.onDemandLimitCents,
    requestUsed: snapshot.requestUsed ?? null,
    requestMax: snapshot.requestMax ?? null,
    planName: snapshot.planName ?? "",
    aggregations: snapshot.aggregations,
    events,
    eventsComplete: snapshot.eventsComplete,
    totalTokens: snapshot.totalTokens,
    dailyBuckets,
    updatedAt: new Date().toISOString(),
  };
}

function fromPersisted(p: PersistedSnapshot): UsageSnapshot {
  return {
    timestamp: new Date(p.updatedAt),
    userId: p.userId,
    accountLabel: p.accountLabel,
    membershipType: p.membershipType,
    billingCycleStart: p.billingCycleStart,
    billingCycleEnd: p.billingCycleEnd,
    isUnlimited: p.isUnlimited,
    displayMode: p.displayMode,
    cursorModelsPercent: p.cursorModelsPercent,
    otherModelsPercent: p.otherModelsPercent,
    totalPercent: p.totalPercent,
    overallUsedCents: p.overallUsedCents,
    overallLimitCents: p.overallLimitCents,
    onDemandEnabled: p.onDemandEnabled,
    onDemandUsedCents: p.onDemandUsedCents,
    onDemandLimitCents: p.onDemandLimitCents,
    requestUsed: p.requestUsed,
    requestMax: p.requestMax,
    planName: p.planName || undefined,
    aggregations: p.aggregations,
    events: normalizeEventTimestamps(p.events),
    eventsComplete: p.eventsComplete,
    totalTokens: p.totalTokens,
    dailyBuckets: (p.dailyBuckets ?? []).filter((b) => b.day >= "2020-01-01"),
  };
}

export async function saveAccountSnapshot(snapshot: UsageSnapshot): Promise<void> {
  if (!snapshot.userId) return;
  const all = readAll();
  const prev = all[snapshot.userId];
  let events = snapshot.events;
  if (prev?.eventsComplete && !snapshot.eventsComplete && prev.events.length > 0) {
    events = mergeEvents(prev.events, snapshot.events);
  }
  const dailyBuckets = snapshot.dailyBuckets ?? prev?.dailyBuckets ?? [];
  all[snapshot.userId] = toPersisted({ ...snapshot, events, dailyBuckets });
  pruneAccounts(all);
  await writeAll(all);
}

/** Drop ghost rows keyed by a stale Sentry userId after identity moved to JWT. */
export async function removeAccountSnapshot(userId: string): Promise<void> {
  if (!userId) return;
  const all = readAll();
  if (!all[userId]) return;
  delete all[userId];
  await writeAll(all);
}

/**
 * Remove zero-usage rows whose userId is not the current session and whose label
 * matches a known stale Sentry email (pre-1.3.9 mis-identity).
 */
export async function pruneIdentityGhosts(opts: {
  currentUserId: string;
  staleUserIds?: string[];
  staleEmails?: string[];
}): Promise<number> {
  const all = readAll();
  let removed = 0;
  const staleIds = new Set((opts.staleUserIds ?? []).filter(Boolean));
  const staleEmails = new Set((opts.staleEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  for (const [uid, snap] of Object.entries(all)) {
    if (uid === opts.currentUserId) continue;
    const label = (snap.accountLabel ?? "").trim().toLowerCase();
    const isStaleId = staleIds.has(uid);
    const isStaleEmail = label && staleEmails.has(label);
    const empty = (snap.totalTokens ?? 0) === 0 && (snap.cursorModelsPercent ?? 0) === 0 && (snap.otherModelsPercent ?? 0) === 0;
    if ((isStaleId || isStaleEmail) && empty) {
      delete all[uid];
      removed++;
    }
  }
  if (removed > 0) await writeAll(all);
  return removed;
}

export function loadAccountSnapshot(userId: string): UsageSnapshot | null {
  const p = readAll()[userId];
  return p ? fromPersisted(p) : null;
}

export function listAccountSnapshots(): UsageSnapshot[] {
  return Object.values(readAll())
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(fromPersisted);
}

export function hydrateSnapshot(stored: UsageSnapshot | null, fresh: UsageSnapshot): UsageSnapshot {
  if (!stored) {
    if (!fresh.eventsComplete) return fresh;
    const compacted = compactEvents(normalizeEventTimestamps(fresh.events), []);
    return { ...fresh, events: compacted.events, dailyBuckets: compacted.dailyBuckets };
  }
  const freshEvents = normalizeEventTimestamps(fresh.events);

  // Full event dump: rebuild sealed days from scratch (replace, never add onto old buckets).
  if (fresh.eventsComplete) {
    const compacted = compactEvents(freshEvents, []);
    return {
      ...fresh,
      events: compacted.events,
      dailyBuckets: compacted.dailyBuckets,
      eventsComplete: true,
      aggregations: fresh.aggregations.length > 0 ? fresh.aggregations : stored.aggregations,
      totalTokens: fresh.totalTokens ?? stored.totalTokens,
      accountLabel: fresh.accountLabel || stored.accountLabel,
    };
  }

  let events = freshEvents;
  if (stored.eventsComplete) {
    events = mergeEvents(normalizeEventTimestamps(stored.events), events);
  } else if (stored.events.length > fresh.events.length) {
    events = mergeEvents(normalizeEventTimestamps(stored.events), events);
  }
  // Prefer sealed buckets from store; compact on save skips those days (no double-count).
  const dailyBuckets = stored.dailyBuckets?.length
    ? stored.dailyBuckets
    : fresh.dailyBuckets?.length
      ? fresh.dailyBuckets
      : [];
  return {
    ...fresh,
    events,
    eventsComplete: stored.eventsComplete,
    aggregations: fresh.aggregations.length > 0 ? fresh.aggregations : stored.aggregations,
    totalTokens: fresh.totalTokens ?? stored.totalTokens,
    accountLabel: fresh.accountLabel || stored.accountLabel,
    dailyBuckets,
  };
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


export function buildCombinedView(accounts: UsageSnapshot[], currentUserId?: string): CombinedViewDto | null {
  if (accounts.length === 0) return null;
  const perAccountRows: CombinedAccountRow[] = accounts.map((a) => {
    const acctStats = computeCacheStats(a.aggregations, a.events);
    const updatedAt = a.timestamp.toISOString();
    return {
      userId: a.userId,
      label: accountLabelFor(a.userId, a.accountLabel),
      membershipType: a.membershipType,
      totalTokens: a.totalTokens,
      cursorModelsPercent: a.cursorModelsPercent,
      otherModelsPercent: a.otherModelsPercent,
      overallUsedCents: a.overallUsedCents,
      overallLimitCents: a.overallLimitCents,
      requestUsed: a.requestUsed ?? null,
      requestMax: a.requestMax ?? null,
      cacheHitRate: acctStats.hitRate,
      cacheReadTokens: acctStats.cacheReadTokens,
      cacheWriteTokens: acctStats.cacheWriteTokens,
      isStale: isAccountStale(updatedAt, currentUserId, a.userId),
      updatedAt,
    };
  });

  let totalTokens = 0;
  let overallUsedCents: number | null = null;
  let overallLimitCents: number | null = null;
  let onDemandUsedCents: number | null = null;
  const allAggs: ModelAgg[] = [];

  for (const a of accounts) {
    totalTokens += a.totalTokens;
    if (a.overallUsedCents !== null) overallUsedCents = (overallUsedCents ?? 0) + a.overallUsedCents;
    if (a.overallLimitCents !== null) overallLimitCents = (overallLimitCents ?? 0) + a.overallLimitCents;
    if (a.onDemandUsedCents !== null) onDemandUsedCents = (onDemandUsedCents ?? 0) + a.onDemandUsedCents;
    allAggs.push(...a.aggregations);
  }

  const events = mergeCombinedEvents(accounts);
  const aggregations = mergeAggs(allAggs);
  const cache = computeCacheStats(aggregations, events);
  const eventCostCents = sumEventCostCents(accounts);
  const eventsComplete = accounts.every((a) => a.eventsComplete);

  return {
    kind: "combined",
    accountLabel: vscode.l10n.t("All accounts ({0})", accounts.length),
    totalTokens,
    overallUsedCents,
    overallLimitCents,
    onDemandUsedCents,
    billingCycleNote: vscode.l10n.t("Billing cycles may differ per account"),
    perAccountRows: sortCombinedAccountRows(perAccountRows, { by: "updated" }),
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
