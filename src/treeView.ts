import * as vscode from "vscode";
import { UsageTracker } from "./tracker";

export class UsageTreeItem extends vscode.TreeItem {
  children?: UsageTreeItem[];
}

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<UsageTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly tracker: UsageTracker) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: UsageTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: UsageTreeItem): UsageTreeItem[] {
    if (element) return element.children || [];
    const config = vscode.workspace.getConfiguration("cursorTokenUsage");
    const hidden = config.get<string[]>("hiddenItems", []);
    const snapshot = this.tracker.lastSnapshot;
    const items: UsageTreeItem[] = [];

    if (snapshot && !hidden.includes("summarySection")) {
      const summary = new UsageTreeItem(
        `📊 ${resetLabel(snapshot.billingCycleEnd, snapshot.membershipType)}`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      summary.contextValue = "summarySection";
      const children: UsageTreeItem[] = [];
      if (!hidden.includes("cursorModels")) {
        children.push(percentItem(vscode.l10n.t("Cursor Models"), "cursorModels", snapshot.cursorModelsPercent, snapshot.isUnlimited));
      }
      if (!hidden.includes("otherModels")) {
        children.push(percentItem(vscode.l10n.t("Other Models"), "otherModels", snapshot.otherModelsPercent, snapshot.isUnlimited));
      }
      if (!hidden.includes("onDemandUsage") && snapshot.onDemandEnabled && snapshot.onDemandUsedCents !== null) {
        const od = new UsageTreeItem(vscode.l10n.t("On-Demand"), vscode.TreeItemCollapsibleState.None);
        const spent = `$${(snapshot.onDemandUsedCents / 100).toFixed(2)}`;
        od.description =
          snapshot.onDemandLimitCents && snapshot.onDemandLimitCents > 0
            ? `${spent}/$${(snapshot.onDemandLimitCents / 100).toFixed(2)}`
            : spent;
        od.iconPath = percentIcon(
          snapshot.onDemandLimitCents && snapshot.onDemandLimitCents > 0
            ? (snapshot.onDemandUsedCents / snapshot.onDemandLimitCents) * 100
            : 0,
        );
        od.contextValue = "summaryChild_onDemandUsage";
        children.push(od);
      }
      if (!hidden.includes("totalTokens")) {
        const tok = new UsageTreeItem(vscode.l10n.t("Total Tokens"), vscode.TreeItemCollapsibleState.None);
        tok.description = formatTokens(snapshot.totalTokens);
        tok.iconPath = new vscode.ThemeIcon("symbol-number");
        tok.contextValue = "summaryChild_totalTokens";
        children.push(tok);
      }
      summary.children = children;
      items.push(summary);
    }

    if (snapshot && snapshot.aggregations.length > 0 && !hidden.includes("modelsSection")) {
      const section = new UsageTreeItem(
        `🧮 ${vscode.l10n.t("By Model ({0})", snapshot.aggregations.length)}`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      section.contextValue = "modelsSection";
      if (this.tracker.aggError) {
        section.description = vscode.l10n.t("(cached)");
      }
      const showDetail = config.get("showTokenDetail", false);
      section.children = snapshot.aggregations.slice(0, 12).map((a) => {
        const row = new UsageTreeItem(
          shortenModel(a.model),
          showDetail ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        row.description = formatTokens(a.totalTokens);
        row.iconPath = new vscode.ThemeIcon("symbol-misc");
        if (showDetail) {
          row.children = [
            leaf(vscode.l10n.t("Input: {0}", formatTokens(a.inputTokens)), "arrow-up"),
            leaf(vscode.l10n.t("Output: {0}", formatTokens(a.outputTokens)), "arrow-down"),
            leaf(vscode.l10n.t("Cache write: {0}", formatTokens(a.cacheWriteTokens)), "database"),
            leaf(vscode.l10n.t("Cache read: {0}", formatTokens(a.cacheReadTokens)), "archive"),
          ];
        }
        return row;
      });
      items.push(section);
    }

    if (!hidden.includes("recentSection")) {
      if (snapshot && snapshot.events.length > 0) {
        const hiddenTs = new Set(config.get<number[]>("hiddenEventTimestamps", []));
        const displayCount = config.get<number>("displayCount", 5);
        const visible = snapshot.events.filter((e) => !hiddenTs.has(e.timestamp)).slice(0, displayCount);
        const recent = new UsageTreeItem(
          `📋 ${vscode.l10n.t("Recent Usage ({0} entries)", visible.length)}`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        recent.contextValue = "recentSection";
        if (this.tracker.eventsError) {
          recent.description = vscode.l10n.t("(cached)");
        }
        const showDetail = config.get("showTokenDetail", false);
        recent.children = visible.map((e) => {
          const entry = new UsageTreeItem(
            `${formatEventTime(e.timestamp)}  ${shortenModel(e.model)}`,
            vscode.TreeItemCollapsibleState.Collapsed,
          );
          entry.id = `event_${e.timestamp}`;
          entry.description = e.kind.includes("USAGE_BASED") ? vscode.l10n.t("On-Demand") : vscode.l10n.t("Included");
          entry.iconPath = e.kind.includes("USAGE_BASED")
            ? new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.orange"))
            : new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
          entry.contextValue = "recentEvent";
          const tokensItem = new UsageTreeItem(
            `${vscode.l10n.t("Tokens")}: ${formatTokens(e.totalTokens)}`,
            showDetail ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
          );
          tokensItem.iconPath = new vscode.ThemeIcon("symbol-number");
          tokensItem.contextValue = "tokensItem";
          if (showDetail) {
            tokensItem.children = [
              leaf(vscode.l10n.t("Input: {0}", formatTokens(e.inputTokens)), "arrow-up"),
              leaf(vscode.l10n.t("Output: {0}", formatTokens(e.outputTokens)), "arrow-down"),
              leaf(vscode.l10n.t("Cache write: {0}", formatTokens(e.cacheWriteTokens)), "database"),
              leaf(vscode.l10n.t("Cache read: {0}", formatTokens(e.cacheReadTokens)), "archive"),
            ];
          }
          entry.children = [tokensItem];
          return entry;
        });
        items.push(recent);
      } else if (snapshot) {
        const empty = new UsageTreeItem(`📋 ${vscode.l10n.t("Recent Usage")}`, vscode.TreeItemCollapsibleState.None);
        empty.description = this.tracker.eventsError ? vscode.l10n.t("Failed to fetch") : vscode.l10n.t("No data");
        items.push(empty);
      }
    }

    const error = this.tracker.lastError;
    if (error && items.length > 0) {
      const banner = new UsageTreeItem(
        this.tracker.consecutiveFailures > 1
          ? vscode.l10n.t("API unavailable (failed {0} times)", this.tracker.consecutiveFailures)
          : error,
        vscode.TreeItemCollapsibleState.None,
      );
      banner.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red"));
      banner.tooltip = vscode.l10n.t("Click refresh to retry");
      items.unshift(banner);
    } else if (items.length === 0) {
      if (error) {
        const errItem = new UsageTreeItem(error, vscode.TreeItemCollapsibleState.None);
        errItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red"));
        items.push(errItem);
      } else {
        const loading = new UsageTreeItem(vscode.l10n.t("Loading..."), vscode.TreeItemCollapsibleState.None);
        loading.iconPath = new vscode.ThemeIcon("sync~spin");
        items.push(loading);
      }
    }
    return items;
  }
}

function percentItem(label: string, id: string, pct: number | null, unlimited: boolean): UsageTreeItem {
  const item = new UsageTreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = unlimited ? "∞" : pct === null ? "—" : `${Math.round(pct)}%`;
  item.iconPath = unlimited ? new vscode.ThemeIcon("infinite") : percentIcon(pct ?? 0);
  item.contextValue = `summaryChild_${id}`;
  return item;
}

function percentIcon(pct: number): vscode.ThemeIcon {
  if (pct < 40) return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
  if (pct < 80) return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.yellow"));
  return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
}

function leaf(label: string, icon: string): UsageTreeItem {
  const item = new UsageTreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function resetLabel(endIso: string, plan: string): string {
  const planLabel = plan ? ` · ${membershipLabel(plan)}` : "";
  if (!endIso) return `${vscode.l10n.t("Billing Cycle")}${planLabel}`;
  const msLeft = Math.max(0, Date.parse(endIso) - Date.now());
  const totalSeconds = Math.ceil(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let countdown: string;
  if (days > 0) countdown = vscode.l10n.t("{0}d {1}h", days, hours);
  else if (hours > 0) countdown = vscode.l10n.t("{0}h {1}m", hours, minutes);
  else countdown = vscode.l10n.t("{0}m {1}s", minutes, seconds);
  return `${vscode.l10n.t("Billing Cycle (Reset in: {0})", countdown)}${planLabel}`;
}

export function isZh(): boolean {
  return vscode.env.language.toLowerCase().startsWith("zh");
}

export function membershipLabel(type: string): string {
  const key = type.trim().toLowerCase();
  if (key === "enterprise") return vscode.l10n.t("Enterprise");
  if (key === "team") return vscode.l10n.t("Team");
  if (key === "pro") return vscode.l10n.t("Pro");
  if (key === "free" || key === "hobby") return vscode.l10n.t("Free");
  return type || "—";
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

import { formatCompactNumber } from "./formatNumber";

export function formatTokens(tokens: number): string {
  return formatCompactNumber(tokens, isZh());
}

export function formatRelativeUpdated(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return vscode.l10n.t("{0}s ago", sec);
  const min = Math.floor(sec / 60);
  if (min < 60) return vscode.l10n.t("{0}m ago", min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return vscode.l10n.t("{0}h ago", hr);
  return vscode.l10n.t("{0}d ago", Math.floor(hr / 24));
}

export function formatEventTime(ts: number): string {
  const ms = ts > 0 && ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  try {
    return d.toLocaleString(vscode.env.language.replace("_", "-"), {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${h}:${m}`;
  }
}

export function shortenModel(model: string): string {
  const cleaned = model
    .replace(/-high-thinking|-medium-thinking|-low-thinking|-thinking/g, "")
    .replace(/-fast$/, " Fast");
  return cleaned
    .split("-")
    .map((p) => (p.length <= 3 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ")
    .slice(0, 48);
}

export function formatPct(pct: number | null, unlimited: boolean): string {
  if (unlimited) return "∞";
  if (pct === null) return "—";
  if (pct > 0 && pct < 1) {
    const one = (Math.round(pct * 10) / 10).toFixed(1);
    return one === "0.0" ? "<0.1%" : `${one}%`;
  }
  return `${Math.round(pct)}%`;
}
