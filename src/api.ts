import * as https from "https";
import * as vscode from "vscode";
import {
  clearCachedToken,
  getAccessToken,
  getUserId,
} from "./credentials";
import {
  FetchResult,
  ModelAgg,
  UsageEvent,
  UsageSnapshot,
} from "./models";

const outputChannel = vscode.window.createOutputChannel("Cursor Token Usage");
const SECRET_KEY = "cursorTokenUsage.sessionToken";
const COOKIE_SAFE_RE = /^[A-Za-z0-9._~%:+-]+$/;
const ALLOWED_HOSTS = new Set(["cursor.com", "www.cursor.com"]);
const PCT_RE = /(\d+(?:\.\d+)?)\s*%/;

let secretStorage: vscode.SecretStorage | null = null;
let autoTokenFailed = false;

export function initSecretStorage(storage: vscode.SecretStorage): void {
  secretStorage = storage;
}

export async function getSecretToken(): Promise<string | undefined> {
  return secretStorage?.get(SECRET_KEY);
}

export async function storeSecretToken(token: string): Promise<void> {
  await secretStorage?.store(SECRET_KEY, token);
}

export async function deleteSecretToken(): Promise<void> {
  await secretStorage?.delete(SECRET_KEY);
}

function log(msg: string): void {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function getSessionToken(): Promise<{ userId: string; cookieValue: string } | null> {
  if (!autoTokenFailed) {
    const userId = await getUserId();
    const accessToken = userId ? await getAccessToken() : null;
    if (userId && accessToken) {
      const cookieValue = `${userId}%3A%3A${accessToken}`;
      if (COOKIE_SAFE_RE.test(cookieValue)) {
        log(`token 来源: 自动 (${userId.slice(0, 10)}...)`);
        return { userId, cookieValue };
      }
    }
  }
  const manualToken = await getSecretToken();
  if (manualToken) {
    if (!COOKIE_SAFE_RE.test(manualToken)) {
      autoTokenFailed = false;
      return null;
    }
    autoTokenFailed = false;
    const manualUserId = manualToken.split("%3A%3A")[0];
    if (!/^user_[a-zA-Z0-9]{20,}$/.test(manualUserId)) return null;
    log(`token 来源: 手动 (${manualUserId.slice(0, 10)}...)`);
    return { userId: manualUserId, cookieValue: manualToken };
  }
  autoTokenFailed = false;
  log("无法获取 Session Token");
  return null;
}

export async function fetchUsage(fullEvents = false): Promise<FetchResult> {
  const session = await getSessionToken();
  if (!session) {
    return { snapshot: null, error: vscode.l10n.t("Unable to get Session Token"), eventsError: false, aggError: false };
  }

  const summary = await httpGet("https://cursor.com/api/usage-summary", session.cookieValue);
  if (!summary) {
    log("获取 /api/usage-summary 失败");
    return { snapshot: null, error: vscode.l10n.t("Failed to fetch usage-summary"), eventsError: false, aggError: false };
  }

  const parsed = parseSummary(summary);

  const startMs = parsed.billingCycleStart
    ? Date.parse(parsed.billingCycleStart)
    : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const endMs = Date.now();

  const [aggResult, eventsResult] = await Promise.all([
    fetchAggregations(session.cookieValue, startMs, endMs),
    fetchUsageEvents(session.cookieValue, startMs, endMs, fullEvents ? EVENT_MAX_PAGES : 1),
  ]);

  const aggregations = aggResult.aggs;
  const totalTokens =
    aggregations.reduce((sum, a) => sum + a.totalTokens, 0) ||
    eventsResult.events.reduce((sum, e) => sum + e.totalTokens, 0);

  return {
    snapshot: {
      timestamp: new Date(),
      ...parsed,
      aggregations,
      events: eventsResult.events,
      eventsComplete: fullEvents,
      totalTokens,
    },
    error: null,
    eventsError: eventsResult.error,
    aggError: aggResult.error,
  };
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

/**
 * Account type is inferred from /api/usage-summary, not from the session token.
 * Individual: plan.autoPercentUsed / apiPercentUsed → pool %.
 * Team/Enterprise: individualUsage.overall used/limit (cents) → $ used/$ limit.
 * Never multiply tokens by list prices; only display cents the API returns.
 */
function parseSummary(data: Record<string, unknown>): Omit<UsageSnapshot, "timestamp" | "aggregations" | "events" | "eventsComplete" | "totalTokens"> {
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
  };
}

async function fetchAggregations(
  cookieValue: string,
  startMs: number,
  endMs: number,
): Promise<{ aggs: ModelAgg[]; error: boolean }> {
  const data = await httpPost(
    "https://cursor.com/api/dashboard/get-aggregated-usage-events",
    { teamId: -1, startDate: startMs, endDate: endMs },
    cookieValue,
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
  return {
    timestamp: toInt(row.timestamp),
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
): Promise<{ events: UsageEvent[]; error: boolean }> {
  const pageSize = EVENT_PAGE_SIZE;
  const events: UsageEvent[] = [];
  let page = 1;
  let truncated = false;
  const pageLimit = Math.max(1, Math.min(EVENT_MAX_PAGES, maxPages));

  while (page <= pageLimit) {
    const data = await httpPost(
      "https://cursor.com/api/dashboard/get-filtered-usage-events",
      { startDate: startMs, endDate: endMs, page, pageSize },
      cookieValue,
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

function httpGet(url: string, cookieValue: string, retryOnAuth = true): Promise<Record<string, unknown> | null> {
  return makeRequest("GET", url, null, cookieValue, retryOnAuth);
}

function httpPost(
  url: string,
  body: Record<string, unknown>,
  cookieValue: string,
  retryOnAuth = true,
): Promise<Record<string, unknown> | null> {
  return makeRequest("POST", url, body, cookieValue, retryOnAuth);
}

function makeRequest(
  method: string,
  url: string,
  body: Record<string, unknown> | null,
  cookieValue: string,
  retryOnAuth: boolean,
  serverRetryCount = 0,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
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
    const req = https.request(options, (res) => {
      req.setTimeout(30000);
      if (res.statusCode === 401) {
        res.resume();
        log(`${method} ${url} → 401，清除缓存并重试`);
        clearCachedToken();
        autoTokenFailed = true;
        if (retryOnAuth) {
          retryRequest(method, url, body).then(safeResolve);
        } else {
          autoTokenFailed = false;
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
          if (res.statusCode && res.statusCode >= 500 && serverRetryCount < 2) {
            const delay = (serverRetryCount + 1) * 3000;
            setTimeout(() => {
              makeRequest(method, url, body, cookieValue, retryOnAuth, serverRetryCount + 1).then(safeResolve);
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
    });
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

async function retryRequest(
  method: string,
  url: string,
  body: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const session = await getSessionToken();
  if (!session) return null;
  return makeRequest(method, url, body, session.cookieValue, false);
}
