export interface UsageEvent {
  timestamp: number;
  model: string;
  kind: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalCents: number;
}

export interface ModelAgg {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface DailyBucket {
  day: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalCents: number;
  requestCount: number;
  byModel: ModelAgg[];
}

export type DisplayMode = "pools" | "overall";

export interface UsageSnapshot {
  timestamp: Date;
  userId: string;
  accountLabel?: string;
  membershipType: string;
  billingCycleStart: string;
  billingCycleEnd: string;
  isUnlimited: boolean;
  displayMode: DisplayMode;
  cursorModelsPercent: number | null;
  otherModelsPercent: number | null;
  totalPercent: number | null;
  overallUsedCents: number | null;
  overallLimitCents: number | null;
  onDemandEnabled: boolean;
  onDemandUsedCents: number | null;
  onDemandLimitCents: number | null;
  aggregations: ModelAgg[];
  events: UsageEvent[];
  eventsComplete: boolean;
  totalTokens: number;
  requestUsed?: number | null;
  requestMax?: number | null;
  planName?: string;
  partialData?: boolean;
  dailyBuckets?: DailyBucket[];
}

export interface FetchResult {
  snapshot: UsageSnapshot | null;
  error: string | null;
  eventsError: boolean;
  aggError: boolean;
}

export interface UsageAlert {
  type: "newSession" | "cursorModels" | "otherModels" | "onDemandSpending" | "overallSpending" | "totalTokens";
  delta: number;
  threshold: number;
}

export type ViewScope = "current" | "all" | "account";

export type StatsRangeMode = "cycle" | "today" | "yesterday" | "7d" | "custom";

export interface StatsRange {
  mode: StatsRangeMode;
  from?: string;
  to?: string;
}

export interface CombinedAccountRow {
  userId: string;
  label: string;
  membershipType: string;
  totalTokens: number;
  cursorModelsPercent: number | null;
  otherModelsPercent: number | null;
  overallUsedCents: number | null;
  overallLimitCents: number | null;
  requestUsed: number | null;
  requestMax: number | null;
  cacheHitRate: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  isStale: boolean;
  updatedAt: string;
}

export interface CombinedViewDto {
  kind: "combined";
  accountLabel: string;
  totalTokens: number;
  overallUsedCents: number | null;
  overallLimitCents: number | null;
  onDemandUsedCents: number | null;
  billingCycleNote: string;
  perAccountRows: CombinedAccountRow[];
  events: UsageEvent[];
  aggregations: ModelAgg[];
  membershipType: string;
  billingCycleEnd: string;
  cacheHitRate: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
  eventCostCents: number;
  eventsComplete: boolean;
}

export interface PanelContext {
  data: PanelData | null;
  viewScope: ViewScope;
  viewAccountId: string | null;
  currentUserId: string | null;
  statsRange: StatsRange;
  accounts: UsageSnapshot[];
}

export interface SessionInfo {
  userId: string;
  accessToken: string;
  cookieValue: string;
}

export interface AccountIdentity {
  userId: string;
  email?: string;
  displayName?: string;
}

export type PanelData = UsageSnapshot | CombinedViewDto;

export function isCombinedView(data: PanelData | null): data is CombinedViewDto {
  return !!data && "kind" in data && data.kind === "combined";
}

/** Prefer email/displayName; never show bare long userId as primary label. */
export function accountLabelFor(userId: string, label?: string): string {
  if (label && label.trim() && !label.startsWith("user_")) return label.trim();
  if (userId.length > 12) return `${userId.slice(0, 8)}…`;
  return userId || "unknown";
}

export function identityToLabel(identity: AccountIdentity | null | undefined, userId: string): string {
  if (identity?.email?.trim()) return identity.email.trim();
  if (identity?.displayName?.trim()) return identity.displayName.trim();
  return accountLabelFor(userId);
}
