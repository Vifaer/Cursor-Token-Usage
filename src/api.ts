import * as https from "https";
import * as vscode from "vscode";
import { upsertAccountSession } from "./accountSessions";
import { getSession, invalidateSession, parseSessionCookie, readAccountIdentity } from "./credentials";
import { FetchResult, ModelAgg, SessionInfo, UsageEvent, UsageSnapshot, identityToLabel } from "./models";

const outputChannel = vscode.window.createOutputChannel("Cursor Token Usage");
const SECRET_KEY = "cursorTokenUsage.sessionToken";
const COOKIE_SAFE_RE = /^[A-Za-z0-9._~%:+-]+$/;
const ALLOWED_HOSTS = new Set(["cursor.com", "www.cursor.com", "api2.cursor.sh"]);
const PCT_RE = /(\d+(?:\.\d+)?)\s*%/;
const LEGACY_CACHE_TTL_MS = 5_000;

let secretStorage: vscode.SecretStorage | null = null;
let autoTokenFailed = false;
/** Set when the latest cookie request saw HTTP 401 (before optional retry). */
let lastCookieAuthFailed = false;
let legacyCache: { token: string; at: number; data: { numRequests: number; maxRequestUsage: number } | null } | null = null;

export function initSecretStorage(storage: vscode.SecretStorage): void {
  secretStorage = storage;
}

export async function getSecretToken(): Promise<string | undefined> {
  return secretStorage?.get(SECRET_KEY);
}

export async function storeSecretToken(token: string): Promise<void> {
  const parsed = parseSessionCookie(token);
  const normalized = parsed?.cookieValue ?? token;
  await secretStorage?.store(SECRET_KEY, normalized);
  if (parsed) await upsertAccountSession(parsed.cookieValue);
}

export async function deleteSecretToken(): Promise<void> {
  await secretStorage?.delete(SECRET_KEY);
}

function log(msg: string): void {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function getSessionToken(): Promise<SessionInfo | null> {
  if (!autoTokenFailed) {
    const session = await getSession();
    if (session && COOKIE_SAFE_RE.test(session.cookieValue)) {
      log(`token 来源: 自动 (${session.userId.slice(0, 10)}...)`);
      return session;
    }
  } else {
    // After 401: try fresh disk session once Cursor re-auths
    invalidateSession();
    const session = await getSession();
    if (session && COOKIE_SAFE_RE.test(session.cookieValue)) {
      autoTokenFailed = false;
      log(`token 来源: 自动恢复 (${session.userId.slice(0, 10)}...)`);
      return session;
    }
  }
  const manualToken = await getSecretToken();
  if (manualToken) {
    const parsed = parseSessionCookie(manualToken);
    if (!parsed || !COOKIE_SAFE_RE.test(parsed.cookieValue)) {
      autoTokenFailed = false;
      return null;
    }
    autoTokenFailed = false;
    log(`token 来源: 手动 (${parsed.userId.slice(0, 10)}...)`);
    return parsed;
  }
  autoTokenFailed = false;
  log("无法获取 Session Token");
  return null;
}

export type FetchUsageOpts = {
  fullEvents?: boolean;
  signal?: AbortSignal;
  session?: SessionInfo;
  accountLabel?: string;
  /** Primary poll may flip disk auth flags; secondary must not. Default true. */
  primary?: boolean;
  /** Inclusive window for aggregations/events; default billing cycle → now. */
  startMs?: number;
  endMs?: number;
};

export async function fetchUsage(
  fullEventsOrOpts: boolean | FetchUsageOpts = false,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const opts: FetchUsageOpts =
    typeof fullEventsOrOpts === "boolean"
      ? { fullEvents: fullEventsOrOpts, signal, primary: true }
      : { primary: true, ...fullEventsOrOpts };
  const fullEvents = !!opts.fullEvents;
  const abort = opts.signal;
  const isPrimary = opts.primary !== false;

  if (abort?.aborted) {
    return { snapshot: null, error: "aborted", eventsError: false, aggError: false };
  }

  const session = opts.session ?? (await getSessionToken());
  if (!session) {
    return { snapshot: null, error: vscode.l10n.t("Unable to get Session Token"), eventsError: false, aggError: false };
  }

  let partialData = false;
  lastCookieAuthFailed = false;
  let summary = await httpGet(
    "https://cursor.com/api/usage-summary",
    session.cookieValue,
    abort,
    isPrimary,
  );
  if (!summary) {
    if (abort?.aborted) {
      return { snapshot: null, error: "aborted", eventsError: false, aggError: false };
    }
    if (!isPrimary && lastCookieAuthFailed) {
      return {
        snapshot: null,
        error: vscode.l10n.t("Failed to fetch usage-summary"),
        eventsError: false,
        aggError: false,
        authError: true,
      };
    }
    log("主路径 usage-summary 失败，尝试 api2 回退");
    const fallback = await fetchFallbackSummary(session, abort);
    if (!fallback) {
      return {
        snapshot: null,
        error: vscode.l10n.t("Failed to fetch usage-summary"),
        eventsError: false,
        aggError: false,
        authError: !isPrimary && lastCookieAuthFailed,
      };
    }
    summary = fallback.summary;
    partialData = fallback.partialData;
  }

  const parsed = parseSummary(summary);
  const needsLegacy =
    parsed.requestMax == null ||
    parsed.requestMax <= 0 ||
    /enterprise|team/i.test(parsed.membershipType);
  if (needsLegacy) {
    const legacy = await fetchLegacyUsage(session.accessToken, abort);
    if (legacy && legacy.maxRequestUsage > 0) {
      parsed.requestUsed = legacy.numRequests;
      parsed.requestMax = legacy.maxRequestUsage;
      parsed.displayMode = "overall";
    }
  }

  const startMs =
    opts.startMs ??
    (parsed.billingCycleStart
      ? Date.parse(parsed.billingCycleStart)
      : Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endMs = opts.endMs ?? Date.now();

  const identityPromise = isPrimary
    ? readAccountIdentity()
    : Promise.resolve(
        opts.accountLabel?.includes("@")
          ? { userId: session.userId, email: opts.accountLabel }
          : opts.accountLabel
            ? { userId: session.userId, displayName: opts.accountLabel }
            : null,
      );

  const [aggResult, eventsResult, identity] = await Promise.all([
    fetchAggregations(session.cookieValue, startMs, endMs, abort, isPrimary),
    fetchUsageEvents(session.cookieValue, startMs, endMs, fullEvents ? EVENT_MAX_PAGES : 1, abort, isPrimary),
    identityPromise,
  ]);

  if (abort?.aborted) {
    return { snapshot: null, error: "aborted", eventsError: false, aggError: false };
  }

  const aggregations = aggResult.aggs;
  const totalTokens =
    aggregations.reduce((sum, a) => sum + a.totalTokens, 0) ||
    eventsResult.events.reduce((sum, e) => sum + e.totalTokens, 0);

  return {
    snapshot: {
      timestamp: new Date(),
      userId: session.userId,
      accountLabel: identityToLabel(identity, session.userId),
      ...parsed,
      aggregations,
      events: eventsResult.events,
      eventsComplete: fullEvents,
      totalTokens,
      partialData,
    },
    error: null,
    eventsError: eventsResult.error,
    aggError: aggResult.error,
  };
}

async function fetchFallbackSummary(
  session: { userId: string; cookieValue: string; accessToken: string },
  signal?: AbortSignal,
): Promise<{ summary: Record<string, unknown>; partialData: boolean } | null> {
  const period = await httpPostApi2(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {},
    session.accessToken,
    signal,
  );
  if (period) {
    const planUsage = (period.planUsage as Record<string, unknown> | undefined) ?? {};
    const used = parseCents(planUsage.used) ?? parseCents(planUsage.spendCents);
    const limit = parseCents(planUsage.limit) ?? parseCents(planUsage.limitCents);
    const totalPct = parsePercent(planUsage.totalPercentUsed);
    return {
      partialData: true,
      summary: {
        membershipType: typeof period.membershipType === "string" ? period.membershipType : "",
        billingCycleStart: period.billingCycleStart ?? period.startDate ?? "",
        billingCycleEnd: period.billingCycleEnd ?? period.endDate ?? "",
        individualUsage: {
          overall: { used, limit },
          plan: {
            autoPercentUsed: parsePercent(planUsage.autoPercentUsed),
            apiPercentUsed: parsePercent(planUsage.apiPercentUsed),
            totalPercentUsed: totalPct,
          },
        },
      },
    };
  }
  const legacy = await fetchLegacyUsage(session.accessToken, signal);
  if (legacy && legacy.maxRequestUsage > 0) {
    return {
      partialData: true,
      summary: {
        membershipType: "enterprise",
        individualUsage: { overall: { used: legacy.numRequests, limit: legacy.maxRequestUsage } },
      },
    };
  }
  return null;
}

async function fetchLegacyUsage(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ numRequests: number; maxRequestUsage: number } | null> {
  const now = Date.now();
  if (legacyCache && legacyCache.token === accessToken && now - legacyCache.at < LEGACY_CACHE_TTL_MS) {
    return legacyCache.data;
  }
  const data = await httpGetBearer("https://api2.cursor.sh/auth/usage", accessToken, signal);
  if (!data) {
    legacyCache = { token: accessToken, at: now, data: null };
    return null;
  }
  const gpt4 = (data["gpt-4"] as Record<string, unknown> | undefined) ?? data;
  const numRequests = toInt(gpt4.numRequests ?? data.numRequests);
  const maxRequestUsage = toInt(gpt4.maxRequestUsage ?? data.maxRequestUsage);
  const result = maxRequestUsage > 0 ? { numRequests, maxRequestUsage } : null;
  legacyCache = { token: accessToken, at: now, data: result };
  return result;
}

function parsePercent(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, value));
  }
  return null;
}

function parsePercentFromMessage(msg: unknown): number | null {
  if (typeof msg !== "string") return null;
  const m = msg.match(PCT_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function parseCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseSummary(
  data: Record<string, unknown>,
): Omit<UsageSnapshot, "timestamp" | "userId" | "accountLabel" | "aggregations" | "events" | "eventsComplete" | "totalTokens"> {
  const individual = (data.individualUsage as Record<string, unknown> | undefined) || {};
  const plan = (individual.plan as Record<string, unknown> | undefined) || {};
  const overall = (individual.overall as Record<string, unknown> | undefined) || {};
  const onDemand = (individual.onDemand as Record<string, unknown> | undefined) || {};
  const team = (data.teamUsage as Record<string, unknown> | undefined) || {};
  const teamOnDemand = (team.onDemand as Record<string, unknown> | undefined) || {};

  const planAuto = parsePercent(plan.autoPercentUsed);
  const planApi = parsePercent(plan.apiPercentUsed);
  const planTotal = parsePercent(plan.totalPercentUsed);
  const hasPlanPercents = planAuto !== null || planApi !== null;

  const overallUsedCents = parseCents(overall.used);
  const overallLimitCents = parseCents(overall.limit);
  const hasOverall = overallUsedCents !== null && overallLimitCents !== null && overallLimitCents > 0;

  let cursorModelsPercent = planAuto;
  let otherModelsPercent = planApi;
  let totalPercent = planTotal;
  if (!hasOverall) {
    if (cursorModelsPercent === null) {
      cursorModelsPercent = parsePercentFromMessage(data.autoModelSelectedDisplayMessage);
    }
    if (otherModelsPercent === null) {
      otherModelsPercent = parsePercentFromMessage(data.namedModelSelectedDisplayMessage);
    }
  }

  const displayMode: UsageSnapshot["displayMode"] = hasPlanPercents || !hasOverall ? "pools" : "overall";
  const membershipType = typeof data.membershipType === "string" ? data.membershipType : "";
  const teamLike = /enterprise|team/i.test(membershipType);
  const individualUsed = parseCents(onDemand.used) ?? parseCents(onDemand.usedCents);
  const teamUsed = parseCents(teamOnDemand.used) ?? parseCents(teamOnDemand.usedCents);
  const onDemandUsedCents = individualUsed !== null ? individualUsed : teamUsed !== null ? teamUsed : teamLike ? 0 : null;
  const individualLimit = parseCents(onDemand.limit);
  const teamLimit = parseCents(teamOnDemand.limit);
  const onDemandLimitCents = individualLimit !== null ? individualLimit : teamLimit;
  const onDemandEnabled =
    onDemand.enabled === true ||
    teamOnDemand.enabled === true ||
    teamLike ||
    (onDemandUsedCents !== null && onDemandUsedCents > 0);

  return {
    membershipType,
    billingCycleStart: typeof data.billingCycleStart === "string" ? data.billingCycleStart : "",
    billingCycleEnd: typeof data.billingCycleEnd === "string" ? data.billingCycleEnd : "",
    isUnlimited: data.isUnlimited === true,
    displayMode,
    cursorModelsPercent,
    otherModelsPercent,
    totalPercent,
    overallUsedCents,
    overallLimitCents: parseCents(overall.limit),
    onDemandEnabled,
    onDemandUsedCents,
    onDemandLimitCents,
    requestUsed: null,
    requestMax: null,
    planName: typeof data.planName === "string" ? data.planName : undefined,
    partialData: false,
  };
}

async function fetchAggregations(
  cookieValue: string,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
  retryOnAuth = true,
): Promise<{ aggs: ModelAgg[]; error: boolean }> {
  const data = await httpPost(
    "https://cursor.com/api/dashboard/get-aggregated-usage-events",
    { teamId: -1, startDate: startMs, endDate: endMs },
    cookieValue,
    retryOnAuth,
    signal,
  );
  const rows = data?.aggregations;
  if (!Array.isArray(rows)) {
    log("get-aggregated-usage-events 无数据");
    return { aggs: [], error: true };
  }
  const aggs: ModelAgg[] = rows.map((row: Record<string, unknown>) => {
    const input = toInt(row.inputTokens);
    const output = toInt(row.outputTokens);
    const cacheWrite = toInt(row.cacheWriteTokens);
    const cacheRead = toInt(row.cacheReadTokens);
    return {
      model: String(row.modelIntent || row.model || "unknown"),
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      totalTokens: input + output + cacheWrite + cacheRead,
    };
  });
  aggs.sort((a, b) => b.totalTokens - a.totalTokens);
  log(`聚合到 ${aggs.length} 个模型`);
  return { aggs, error: false };
}

const EVENT_PAGE_SIZE = 100;
const EVENT_MAX_PAGES = 30;

function mapUsageEvent(e: unknown): UsageEvent {
  const row = (e || {}) as Record<string, unknown>;
  const tok = (row.tokenUsage as Record<string, unknown> | undefined) || {};
  const input = toInt(tok.inputTokens);
  const output = toInt(tok.outputTokens);
  const cacheWrite = toInt(tok.cacheWriteTokens);
  const cacheRead = toInt(tok.cacheReadTokens);
  const rawTs = toInt(row.timestamp);
  return {
    timestamp: rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs,
    model: String(row.model || "unknown"),
    kind: String(row.kind || ""),
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    totalTokens: input + output + cacheWrite + cacheRead,
    totalCents: parseCents(tok.totalCents) ?? parseCents(row.chargedCents) ?? 0,
  };
}

async function fetchUsageEvents(
  cookieValue: string,
  startMs: number,
  endMs: number,
  maxPages = EVENT_MAX_PAGES,
  signal?: AbortSignal,
  retryOnAuth = true,
): Promise<{ events: UsageEvent[]; error: boolean }> {
  const pageSize = EVENT_PAGE_SIZE;
  const events: UsageEvent[] = [];
  let page = 1;
  let truncated = false;
  const pageLimit = Math.max(1, Math.min(EVENT_MAX_PAGES, maxPages));

  while (page <= pageLimit) {
    if (signal?.aborted) return { events, error: false };
    const data = await httpPost(
      "https://cursor.com/api/dashboard/get-filtered-usage-events",
      { startDate: startMs, endDate: endMs, page, pageSize },
      cookieValue,
      retryOnAuth,
      signal,
    );
    const rows = data?.usageEventsDisplay;
    if (!Array.isArray(rows)) {
      if (page === 1) {
        log("get-filtered-usage-events 无数据");
        return { events: [], error: true };
      }
      log(`get-filtered-usage-events 第 ${page} 页失败，使用已拉取的 ${events.length} 条`);
      return { events, error: false };
    }
    events.push(...rows.map(mapUsageEvent));
    const total = toInt(data?.totalUsageEventsCount);
    log(`获取到第 ${page} 页 ${rows.length} 条用量事件 (累计 ${events.length}${total > 0 ? `/${total}` : ""})`);
    if (rows.length < pageSize) break;
    if (total > 0 && events.length >= total) break;
    page += 1;
    if (page > pageLimit) truncated = true;
  }
  if (truncated) {
    log(`事件达到页数上限 ${pageLimit}（${EVENT_PAGE_SIZE}/页），已截断`);
  }
  return { events, error: false };
}

function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

function httpGet(
  url: string,
  cookieValue: string,
  signal?: AbortSignal,
  retryOnAuth = true,
): Promise<Record<string, unknown> | null> {
  return makeRequest("GET", url, null, cookieValue, retryOnAuth, 0, signal);
}

function httpGetBearer(url: string, bearer: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  return makeBearerRequest("GET", url, null, bearer, signal);
}

function httpPost(
  url: string,
  body: Record<string, unknown>,
  cookieValue: string,
  retryOnAuth = true,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  return makeRequest("POST", url, body, cookieValue, retryOnAuth, 0, signal);
}

function httpPostApi2(
  url: string,
  body: Record<string, unknown>,
  bearer: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  return makeBearerRequest("POST", url, body, bearer, signal);
}

function makeRequest(
  method: string,
  url: string,
  body: Record<string, unknown> | null,
  cookieValue: string,
  retryOnAuth: boolean,
  serverRetryCount = 0,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const urlObj = new URL(url);
    if (!ALLOWED_HOSTS.has(urlObj.hostname)) {
      log(`${method} ${url} → 主机不在白名单`);
      resolve(null);
      return;
    }
    let settled = false;
    const safeResolve = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const onAbort = () => {
      req.destroy();
      safeResolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const postData = body ? JSON.stringify(body) : null;
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: `WorkosCursorSessionToken=${cookieValue}`,
        Origin: "https://cursor.com",
        Referer: "https://cursor.com/dashboard/usage",
        ...(postData ? { "Content-Length": Buffer.byteLength(postData).toString() } : {}),
      },
    };
    const req = https.request(options, (res) =>
      handleResponse(res, req, method, url, body, cookieValue, retryOnAuth, serverRetryCount, safeResolve, signal),
    );
    req.on("error", (err) => {
      log(`${method} ${url} → 网络错误: ${err.message}`);
      safeResolve(null);
    });
    req.setTimeout(30000, () => {
      log(`${method} ${url} → 超时`);
      req.destroy();
      safeResolve(null);
    });
    if (postData) req.write(postData);
    req.end();
  });
}

function makeBearerRequest(
  method: string,
  url: string,
  body: Record<string, unknown> | null,
  bearer: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const urlObj = new URL(url);
    if (!ALLOWED_HOSTS.has(urlObj.hostname)) {
      resolve(null);
      return;
    }
    let settled = false;
    const safeResolve = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const postData = body ? JSON.stringify(body) : null;
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        ...(postData ? { "Content-Length": Buffer.byteLength(postData).toString() } : {}),
      },
    };
    const req = https.request(options, (res) => {
      req.setTimeout(30000);
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        safeResolve(null);
        return;
      }
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          safeResolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          safeResolve(null);
        }
      });
    });
    const onAbort = () => {
      req.destroy();
      safeResolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", () => safeResolve(null));
    req.setTimeout(30000, () => {
      req.destroy();
      safeResolve(null);
    });
    if (postData) req.write(postData);
    req.end();
  });
}

function handleResponse(
  res: import("http").IncomingMessage,
  req: import("http").ClientRequest,
  method: string,
  url: string,
  body: Record<string, unknown> | null,
  cookieValue: string,
  retryOnAuth: boolean,
  serverRetryCount: number,
  safeResolve: (value: Record<string, unknown> | null) => void,
  signal?: AbortSignal,
): void {
  req.setTimeout(30000);
  if (res.statusCode === 401) {
    res.resume();
    lastCookieAuthFailed = true;
    log(`${method} ${url} → 401，清除缓存并重试`);
    if (retryOnAuth) {
      invalidateSession();
      autoTokenFailed = true;
      if (!signal?.aborted) {
        retryRequest(method, url, body, signal).then(safeResolve);
      } else {
        autoTokenFailed = false;
        safeResolve(null);
      }
    } else {
      safeResolve(null);
    }
    return;
  }
  if (res.statusCode && res.statusCode >= 400) {
    let errData = "";
    res.on("data", (chunk) => {
      if (errData.length < 64 * 1024) errData += chunk.toString();
    });
    res.on("end", () => {
      log(`${method} ${url} → HTTP ${res.statusCode}: ${errData.slice(0, 300)}`);
      if (res.statusCode && res.statusCode >= 500 && serverRetryCount < 2 && !signal?.aborted) {
        const delay = (serverRetryCount + 1) * 3000;
        setTimeout(() => {
          makeRequest(method, url, body, cookieValue, retryOnAuth, serverRetryCount + 1, signal).then(safeResolve);
        }, delay);
      } else {
        safeResolve(null);
      }
    });
    return;
  }
  if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
    res.resume();
    log(`${method} ${url} → 重定向已拒绝`);
    safeResolve(null);
    return;
  }
  const MAX_BODY = 5 * 1024 * 1024;
  let data = "";
  res.on("data", (chunk) => {
    data += chunk;
    if (data.length > MAX_BODY) {
      req.destroy();
      safeResolve(null);
    }
  });
  res.on("end", () => {
    try {
      safeResolve(JSON.parse(data) as Record<string, unknown>);
    } catch {
      log(`${method} ${url} → JSON 解析失败`);
      safeResolve(null);
    }
  });
}

async function retryRequest(
  method: string,
  url: string,
  body: Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const session = await getSessionToken();
  if (!session) return null;
  return makeRequest(method, url, body, session.cookieValue, false, 0, signal);
}
