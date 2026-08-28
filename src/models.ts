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

export type DisplayMode = "pools" | "overall";

export interface UsageSnapshot {
  timestamp: Date;
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
