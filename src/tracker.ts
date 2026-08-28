import * as vscode from "vscode";
import { fetchUsage } from "./api";
import { FetchResult, UsageAlert, UsageSnapshot } from "./models";

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
        await this.waitIdle();
        return this.poll(false, { fullEvents: fullEvents || this._queuedFull });
      }
      log.appendLine(`[${new Date().toISOString()}] poll 上次轮询超时，强制重置`);
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
    try {
      const result = await Promise.race<FetchResult>([
        fetchUsage(fullEvents),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ snapshot: null, error: vscode.l10n.t("Timed out fetching usage"), eventsError: false, aggError: false }),
            90000,
          ),
        ),
      ]);
      if (!result.snapshot) {
        this._lastError = result.error;
        this._consecutiveFailures++;
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
      if (prev?.eventsComplete && !snapshot.eventsComplete) {
        const seen = new Set(prev.events.map((e) => `${e.timestamp}|${e.model}|${e.kind}`));
        const extras = snapshot.events.filter((e) => !seen.has(`${e.timestamp}|${e.model}|${e.kind}`));
        const events = extras.length > 0 ? [...extras, ...prev.events] : prev.events;
        snapshot = { ...snapshot, events, eventsComplete: true };
        log.appendLine(`[${ts}] poll#${pollId} lite 合并 ${extras.length} 条新事件，共 ${events.length} 条`);
      }
      log.appendLine(
        `[${ts}] poll#${pollId} 成功 full=${snapshot.eventsComplete} events=${snapshot.events.length} C=${snapshot.cursorModelsPercent} O=${snapshot.otherModelsPercent} totalPct=${snapshot.totalPercent} tokens=${snapshot.totalTokens}`,
      );
      this._lastSnapshot = snapshot;
      if (prev && !wasRecovering) this.checkAlerts(prev, snapshot);
      this._onUpdate?.();
      return true;
    } catch (err) {
      log.appendLine(`[${ts}] poll#${pollId} 异常: ${err}`);
      return false;
    }
  }

  private checkAlerts(prev: UsageSnapshot, curr: UsageSnapshot): void {
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
}
