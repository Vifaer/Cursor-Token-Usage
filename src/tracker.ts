import * as vscode from "vscode";
import { fetchUsage } from "./api";
import {
  dropAccountSession,
  listAccountSessions,
  MAX_STORED_SESSION_POLLS,
  upsertAccountSession,
} from "./accountSessions";
import {
  buildCombinedView,
  hydrateSnapshot,
  listAccountSnapshots,
  loadAccountSnapshot,
  parseSavedViewScope,
  pruneIdentityGhosts,
  saveAccountSnapshot,
  saveViewScope,
} from "./accountStore";
import { mergeEvents } from "./mergeEvents";
import { getSession, readFileIdentityHints } from "./credentials";
import { CombinedViewDto, UsageAlert, UsageSnapshot, ViewScope } from "./models";
import { dayEndMs, dayStartMs } from "./trendData";
import { applyFetchedRange, normalizeEventTimestamps } from "./dailyBuckets";

const log = vscode.window.createOutputChannel("Cursor Token Usage - Tracker");

export class UsageTracker {
  private _lastSnapshot: UsageSnapshot | null = null;
  private _lastError: string | null = null;
  private _eventsError = false;
  private _aggError = false;
  private _consecutiveFailures = 0;
  private _lastSuccessTime: Date | null = null;
  private _onUpdate: (() => void) | null = null;
  private _onAlert: ((alerts: UsageAlert[]) => void) | null = null;
  private _polling = false;
  private _pollStartTime = 0;
  private _pollCount = 0;
  private _queuedFull = false;
  private _idleWaiters: Array<() => void> = [];
  private _running: Promise<boolean> | null = null;
  private _viewScope: ViewScope = "all";
  private _viewAccountId: string | null = null;
  private _abortController: AbortController | null = null;

  set onUpdate(callback: () => void) {
    this._onUpdate = callback;
  }

  set onAlert(callback: (alerts: UsageAlert[]) => void) {
    this._onAlert = callback;
  }

  get lastSnapshot(): UsageSnapshot | null {
    return this._lastSnapshot;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get eventsError(): boolean {
    return this._eventsError;
  }

  get aggError(): boolean {
    return this._aggError;
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  get lastSuccessTime(): Date | null {
    return this._lastSuccessTime;
  }

  get viewScope(): ViewScope {
    return this._viewScope;
  }

  get viewAccountId(): string | null {
    return this._viewAccountId;
  }

  /** Cold-start: show cached account immediately and restore view scope. */
  hydrateFromStore(): void {
    const accounts = listAccountSnapshots();
    if (accounts.length === 0) return;
    this._lastSnapshot = accounts[0];
    this._lastSuccessTime = accounts[0].timestamp;
    const saved = parseSavedViewScope();
    if (accounts.length > 0) {
      this._viewScope = saved.scope;
      this._viewAccountId = saved.scope === "account" ? saved.accountId : null;
      if (this._viewScope === "account" && this._viewAccountId && !loadAccountSnapshot(this._viewAccountId)) {
        this._viewScope = "all";
        this._viewAccountId = null;
      }
    }
    this._onUpdate?.();
  }

  setViewScope(scope: ViewScope, accountId?: string): void {
    this._viewScope = scope;
    this._viewAccountId = scope === "account" ? accountId ?? null : null;
    void saveViewScope(scope, this._viewAccountId);
    this._onUpdate?.();
  }

  getPanelContext(): import("./models").PanelContext {
    const accounts = this.getPanelAccounts();
    return {
      data: this.getPanelData(),
      viewScope: this._viewScope,
      viewAccountId: this._viewAccountId,
      currentUserId: this._lastSnapshot?.userId ?? null,
      statsRange: { mode: "cycle" },
      accounts,
    };
  }

  getPanelAccounts(): UsageSnapshot[] {
    if (this._viewScope === "account" && this._viewAccountId) {
      const s = loadAccountSnapshot(this._viewAccountId);
      return s ? [s] : [];
    }
    if (this._viewScope === "all") {
      return dedupeByUserId(
        [this._lastSnapshot, ...listOtherAccounts(this._lastSnapshot?.userId)].filter(Boolean) as UsageSnapshot[],
      );
    }
    return this._lastSnapshot ? [this._lastSnapshot] : [];
  }

  getCombinedView(): CombinedViewDto | null {
    const accounts = dedupeByUserId(
      [this._lastSnapshot, ...listOtherAccounts(this._lastSnapshot?.userId)].filter(Boolean) as UsageSnapshot[],
    );
    return buildCombinedView(accounts, this._lastSnapshot?.userId);
  }

  getPanelData(): UsageSnapshot | CombinedViewDto | null {
    if (this._viewScope === "all") {
      const accounts = dedupeByUserId(
        [this._lastSnapshot, ...listOtherAccounts(this._lastSnapshot?.userId)].filter(Boolean) as UsageSnapshot[],
      );
      return buildCombinedView(accounts, this._lastSnapshot?.userId);
    }
    if (this._viewScope === "account" && this._viewAccountId) {
      return loadAccountSnapshot(this._viewAccountId);
    }
    return this._lastSnapshot;
  }

  private notifyIdle(): void {
    const waiters = this._idleWaiters.splice(0);
    for (const wait of waiters) wait();
  }

  private waitIdle(): Promise<void> {
    if (!this._polling && !this._running) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  async poll(force = false, opts?: { fullEvents?: boolean }): Promise<boolean> {
    const fullEvents = !!opts?.fullEvents;
    if (fullEvents) this._queuedFull = true;

    if (this._running) {
      const elapsed = Date.now() - this._pollStartTime;
      if (!force && elapsed <= 120000) {
        log.appendLine(`[${new Date().toISOString()}] poll SKIPPED${fullEvents ? " (queued full)" : ""}`);
        return false;
      }
      if (force) {
        log.appendLine(`[${new Date().toISOString()}] poll waiting for in-flight${fullEvents ? " then full" : ""}`);
        this._abortController?.abort();
        await this.waitIdle();
        return this.poll(false, { fullEvents: fullEvents || this._queuedFull });
      }
      log.appendLine(`[${new Date().toISOString()}] poll 上次轮询超时，强制重置`);
      this._abortController?.abort();
      this._pollCount++;
      this._running = null;
      this._polling = false;
      this.notifyIdle();
    }

    const runFull = fullEvents || this._queuedFull;
    this._queuedFull = false;
    const task = this.runPoll(runFull);
    this._running = task.finally(() => {
      if (this._running === task) this._running = null;
      this._polling = false;
      const hasWaiters = this._idleWaiters.length > 0;
      const followUp = this._queuedFull && !hasWaiters && !runFull;
      this.notifyIdle();
      if (followUp) void this.poll(false, { fullEvents: true });
    });
    return task;
  }

  private async runPoll(fullEvents: boolean): Promise<boolean> {
    this._pollCount++;
    const pollId = this._pollCount;
    const ts = new Date().toISOString();
    this._polling = true;
    this._pollStartTime = Date.now();
    this._abortController?.abort();
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const timeout = setTimeout(() => this._abortController?.abort(), 90000);

    try {
      const result = await fetchUsage(fullEvents, signal);
      if (signal.aborted || result.error === "aborted") {
        if (pollId === this._pollCount) {
          log.appendLine(`[${ts}] poll#${pollId} aborted`);
        }
        return false;
      }
      if (!result.snapshot) {
        this._lastError = result.error;
        this._consecutiveFailures++;
        this._eventsError = result.eventsError;
        this._aggError = result.aggError;
        log.appendLine(`[${ts}] poll#${pollId} 失败: ${result.error}`);
        this._onUpdate?.();
        return false;
      }
      if (pollId !== this._pollCount) {
        log.appendLine(`[${ts}] poll#${pollId} 已过期，丢弃结果`);
        return false;
      }

      const wasRecovering = this._consecutiveFailures > 0;
      this._lastError = null;
      this._consecutiveFailures = 0;
      this._lastSuccessTime = new Date();
      this._eventsError = result.eventsError;
      this._aggError = result.aggError;

      const prev = this._lastSnapshot;
      let snapshot = result.snapshot;
      const accountSwitched = !!prev && prev.userId !== snapshot.userId;

      if (accountSwitched) {
        log.appendLine(`[${ts}] poll#${pollId} 账号切换 ${prev!.userId.slice(0, 10)} → ${snapshot.userId.slice(0, 10)}`);
        await saveAccountSnapshot(prev!);
        const stored = loadAccountSnapshot(snapshot.userId);
        snapshot = hydrateSnapshot(stored, snapshot);
        this._lastSnapshot = snapshot;
        await saveAccountSnapshot(snapshot);
        await this.pruneGhostAccounts(snapshot.userId);
        await this.refreshStoredSessions(snapshot, signal, ts, pollId);
        this._onUpdate?.();
        return true;
      }

      if (prev?.userId === snapshot.userId && prev.eventsComplete && !snapshot.eventsComplete) {
        snapshot = {
          ...snapshot,
          events: mergeEvents(prev.events, snapshot.events),
          eventsComplete: true,
          dailyBuckets: prev.dailyBuckets,
        };
        log.appendLine(`[${ts}] poll#${pollId} lite 合并事件，共 ${snapshot.events.length} 条`);
      } else {
        const stored = loadAccountSnapshot(snapshot.userId);
        snapshot = hydrateSnapshot(stored, snapshot);
      }

      log.appendLine(
        `[${ts}] poll#${pollId} 成功 user=${snapshot.userId.slice(0, 10)} label=${snapshot.accountLabel ?? "-"} full=${snapshot.eventsComplete} events=${snapshot.events.length} tokens=${snapshot.totalTokens}`,
      );
      this._lastSnapshot = snapshot;
      await saveAccountSnapshot(snapshot);
      await this.pruneGhostAccounts(snapshot.userId);
      await this.refreshStoredSessions(snapshot, signal, ts, pollId);

      if (prev && !wasRecovering && prev.userId === snapshot.userId) this.checkAlerts(prev, snapshot);

      const config = vscode.workspace.getConfiguration("cursorTokenUsage");
      if (config.get<boolean>("showOverLimitToast", false) && usageOverLimit(snapshot)) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Cursor usage limit reached or exceeded"));
      }

      this._onUpdate?.();
      return true;
    } catch (err) {
      log.appendLine(`[${ts}] poll#${pollId} 异常: ${err}`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private checkAlerts(prev: UsageSnapshot, curr: UsageSnapshot): void {
    if (prev.userId !== curr.userId) return;
    const config = vscode.workspace.getConfiguration("cursorTokenUsage");
    if (!config.get("alertEnabled", true)) return;
    const items = config.get<string[]>("alertItems", ["newSession", "cursorModels", "otherModels", "totalTokens"]);
    const alerts: UsageAlert[] = [];

    if (items.includes("newSession") && prev.eventsComplete && curr.eventsComplete) {
      const prevTs = new Set(prev.events.map((e) => e.timestamp));
      const newCount = curr.events.filter((e) => !prevTs.has(e.timestamp)).length;
      const threshold = config.get("alertThreshold.newSession", 2);
      if (newCount >= threshold && newCount > 0) {
        alerts.push({ type: "newSession", delta: newCount, threshold });
      }
    }
    if (items.includes("cursorModels") && prev.cursorModelsPercent !== null && curr.cursorModelsPercent !== null) {
      const delta = curr.cursorModelsPercent - prev.cursorModelsPercent;
      const threshold = config.get("alertThreshold.cursorModels", 10);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "cursorModels", delta, threshold });
      }
    }
    if (items.includes("otherModels") && prev.otherModelsPercent !== null && curr.otherModelsPercent !== null) {
      const delta = curr.otherModelsPercent - prev.otherModelsPercent;
      const threshold = config.get("alertThreshold.otherModels", 10);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "otherModels", delta, threshold });
      }
    }
    if (items.includes("overallSpending") && prev.overallUsedCents !== null && curr.overallUsedCents !== null) {
      const delta = (curr.overallUsedCents - prev.overallUsedCents) / 100;
      const threshold = config.get("alertThreshold.overallSpending", 1);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "overallSpending", delta, threshold });
      }
    }
    if (items.includes("onDemandSpending") && prev.onDemandUsedCents !== null && curr.onDemandUsedCents !== null) {
      const delta = (curr.onDemandUsedCents - prev.onDemandUsedCents) / 100;
      const threshold = config.get("alertThreshold.onDemandSpending", 1);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "onDemandSpending", delta, threshold });
      }
    }
    if (items.includes("totalTokens")) {
      const delta = curr.totalTokens - prev.totalTokens;
      const threshold = config.get("alertThreshold.totalTokens", 100000);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "totalTokens", delta, threshold });
      }
    }
    if (alerts.length > 0) this._onAlert?.(alerts);
  }

  /** Drop empty Sentry-mislabeled rows after JWT identity fix. */
  private async pruneGhostAccounts(currentUserId: string): Promise<void> {
    try {
      const hints = await readFileIdentityHints();
      const removed = await pruneIdentityGhosts({
        currentUserId,
        staleUserIds: hints.userId ? [hints.userId] : [],
        staleEmails: hints.email ? [hints.email] : [],
      });
      if (removed > 0) {
        log.appendLine(`[cursor-token-usage] pruned ${removed} identity ghost account(s)`);
      }
    } catch (err) {
      log.appendLine(`[cursor-token-usage] prune ghosts: ${err}`);
    }
  }

  /** Upsert current JWT; lite-poll other retained JWTs (never same accessToken). */
  private async refreshStoredSessions(
    current: UsageSnapshot,
    signal: AbortSignal,
    ts: string,
    pollId: number,
  ): Promise<void> {
    try {
      const session = await getSession();
      if (session && session.userId === current.userId) {
        const email = current.accountLabel?.includes("@") ? current.accountLabel : undefined;
        await upsertAccountSession(session.cookieValue, email);
      }
      const others = await listAccountSessions({
        excludeAccessToken: session?.accessToken,
        excludeUserId: current.userId,
        limit: MAX_STORED_SESSION_POLLS,
      });
      if (others.length === 0 || signal.aborted) return;
      log.appendLine(`[${ts}] poll#${pollId} refreshing ${others.length} stored session(s)`);
      await Promise.all(
        others.map(async (s) => {
          if (signal.aborted) return;
          const r = await fetchUsage({
            fullEvents: false,
            signal,
            session: s,
            accountLabel: s.email,
            primary: false,
          });
          if (r.authError) {
            log.appendLine(`[${ts}] poll#${pollId} drop stored ${s.userId.slice(0, 10)} (401)`);
            await dropAccountSession(s.userId);
            return;
          }
          if (!r.snapshot) return;
          const prevStored = loadAccountSnapshot(r.snapshot.userId);
          const hydrated = hydrateSnapshot(prevStored, r.snapshot);
          await saveAccountSnapshot(hydrated);
          const labelEmail = hydrated.accountLabel?.includes("@") ? hydrated.accountLabel : s.email;
          await upsertAccountSession(s.cookieValue, labelEmail);
        }),
      );
    } catch (err) {
      log.appendLine(`[${ts}] poll#${pollId} stored sessions: ${err}`);
    }
  }

  /**
   * Fetch events for [from, to] (local days), REPLACE sealed buckets for those days,
   * merge today's events only. Does not overwrite cycle aggregations/totalTokens.
   */
  async queryRange(from: string, to: string): Promise<boolean> {
    await this.waitIdle();
    const startMs = dayStartMs(from);
    const endMs = dayEndMs(to);
    const ts = new Date().toISOString();
    log.appendLine(`[${ts}] queryRange ${from}..${to}`);
    try {
      const result = await fetchUsage({ fullEvents: true, startMs, endMs });
      if (!result.snapshot) {
        this._lastError = result.error;
        this._onUpdate?.();
        return false;
      }
      const fresh = result.snapshot;
      const stored = loadAccountSnapshot(fresh.userId);
      const prev = this._lastSnapshot?.userId === fresh.userId ? this._lastSnapshot : stored;
      const fetched = normalizeEventTimestamps(fresh.events);
      const applied = applyFetchedRange(
        normalizeEventTimestamps(prev?.events ?? stored?.events ?? []),
        prev?.dailyBuckets ?? stored?.dailyBuckets ?? [],
        fetched,
        from,
        to,
      );
      const snapshot: UsageSnapshot = {
        ...fresh,
        events: applied.events,
        eventsComplete: prev?.eventsComplete ?? stored?.eventsComplete ?? false,
        aggregations:
          (prev?.aggregations?.length ? prev.aggregations : stored?.aggregations) ?? fresh.aggregations,
        totalTokens: prev?.totalTokens ?? stored?.totalTokens ?? fresh.totalTokens,
        dailyBuckets: applied.dailyBuckets,
        accountLabel: fresh.accountLabel || prev?.accountLabel || stored?.accountLabel,
      };
      this._lastSnapshot = snapshot;
      this._lastError = null;
      this._lastSuccessTime = new Date();
      this._eventsError = result.eventsError;
      this._aggError = result.aggError;
      await saveAccountSnapshot(snapshot);
      log.appendLine(
        `[${ts}] queryRange ok fetched=${fetched.length} todayEvents=${snapshot.events.length} buckets=${snapshot.dailyBuckets?.length ?? 0}`,
      );
      this._onUpdate?.();
      return true;
    } catch (err) {
      log.appendLine(`[${ts}] queryRange error: ${err}`);
      return false;
    }
  }
}

function listOtherAccounts(currentUserId?: string): UsageSnapshot[] {
  return listAccountSnapshots().filter((a) => a.userId !== currentUserId);
}

function dedupeByUserId(accounts: UsageSnapshot[]): UsageSnapshot[] {
  const map = new Map<string, UsageSnapshot>();
  for (const a of accounts) {
    if (!a.userId) continue;
    const prev = map.get(a.userId);
    if (!prev || a.timestamp.getTime() >= prev.timestamp.getTime()) {
      map.set(a.userId, a);
    }
  }
  return [...map.values()];
}

function usageOverLimit(snapshot: UsageSnapshot): boolean {
  if (snapshot.requestMax && snapshot.requestUsed !== null && snapshot.requestUsed !== undefined) {
    return snapshot.requestUsed >= snapshot.requestMax;
  }
  if (snapshot.overallUsedCents !== null && snapshot.overallLimitCents && snapshot.overallLimitCents > 0) {
    return snapshot.overallUsedCents >= snapshot.overallLimitCents;
  }
  const pct = Math.max(snapshot.cursorModelsPercent ?? 0, snapshot.otherModelsPercent ?? 0);
  return pct >= 100;
}
