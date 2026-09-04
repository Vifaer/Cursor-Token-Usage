import { mergeEvents } from "./mergeEvents";
import { DailyBucket, ModelAgg, UsageEvent } from "./models";

export const LEGACY_ACCOUNTS_KEY = "cursorTokenUsage.accounts.v1";

export interface PersistedSnapshot {
  userId: string;
  accountLabel?: string;
  membershipType: string;
  billingCycleStart: string;
  billingCycleEnd: string;
  isUnlimited: boolean;
  displayMode: "pools" | "overall";
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

function isSnapshot(v: unknown): v is PersistedSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.userId === "string" && o.userId.startsWith("user_") && typeof o.updatedAt === "string";
}

function mergeBuckets(a: DailyBucket[] = [], b: DailyBucket[] = []): DailyBucket[] {
  const map = new Map<string, DailyBucket>();
  for (const row of [...a, ...b]) {
    const prev = map.get(row.day);
    if (!prev) {
      map.set(row.day, { ...row, byModel: [...(row.byModel ?? [])] });
      continue;
    }
    if ((row.totalTokens ?? 0) > (prev.totalTokens ?? 0)) {
      map.set(row.day, { ...row, byModel: [...(row.byModel ?? [])] });
    }
  }
  return [...map.values()].sort((x, y) => x.day.localeCompare(y.day));
}

export function mergePersistedSnapshots(a: PersistedSnapshot, b: PersistedSnapshot): PersistedSnapshot {
  const aNewer = Date.parse(a.updatedAt) >= Date.parse(b.updatedAt);
  const newer = aNewer ? a : b;
  const older = aNewer ? b : a;
  return {
    ...newer,
    events: mergeEvents(older.events ?? [], newer.events ?? []),
    eventsComplete: !!(newer.eventsComplete || older.eventsComplete),
    dailyBuckets: mergeBuckets(older.dailyBuckets, newer.dailyBuckets),
    aggregations: (newer.aggregations?.length ? newer.aggregations : older.aggregations) ?? [],
    totalTokens: Math.max(newer.totalTokens ?? 0, older.totalTokens ?? 0),
    accountLabel: newer.accountLabel || older.accountLabel,
  };
}

export function parseLegacyAccounts(raw: string | null): Record<string, PersistedSnapshot> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const accounts = data[LEGACY_ACCOUNTS_KEY];
    if (!accounts || typeof accounts !== "object") return {};
    const out: Record<string, PersistedSnapshot> = {};
    for (const [uid, snap] of Object.entries(accounts as Record<string, unknown>)) {
      if (!isSnapshot(snap)) continue;
      const id = snap.userId || uid;
      if (!id.startsWith("user_")) continue;
      out[id] = {
        ...snap,
        userId: id,
        dailyBuckets: snap.dailyBuckets ?? [],
        events: snap.events ?? [],
        aggregations: snap.aggregations ?? [],
      };
    }
    return out;
  } catch {
    return {};
  }
}
