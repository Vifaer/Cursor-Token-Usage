import * as vscode from "vscode";
import { sortCombinedAccountRows } from "./combinedView";
import { formatHitRate } from "./cacheStats";
import { CombinedViewDto, UsageSnapshot } from "./models";
import {
  formatAccountTooltipRow,
  tooltipHeaderRow,
  tooltipSeparator,
} from "./tooltipFormat";
import { formatPct, formatTokens, membershipLabel } from "./treeView";
const TOOLTIP_ACCOUNT_ROWS = 10;

export type StatusBarFormat = "percent" | "amount" | "amount_with_reset" | "amount_with_plan";
export type DisplayFormat = "remaining" | "fraction" | "compact";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function usedPercent(snapshot: UsageSnapshot): number {
  if (snapshot.requestMax && snapshot.requestMax > 0 && snapshot.requestUsed !== null && snapshot.requestUsed !== undefined) {
    return (snapshot.requestUsed / snapshot.requestMax) * 100;
  }
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents && snapshot.overallLimitCents > 0) {
    return (snapshot.overallUsedCents / snapshot.overallLimitCents) * 100;
  }
  return Math.max(snapshot.cursorModelsPercent ?? 0, snapshot.otherModelsPercent ?? 0);
}

function trafficLight(snapshot: UsageSnapshot, config: vscode.WorkspaceConfiguration): string {
  if (!config.get<boolean>("showTrafficLight", false)) return "";
  const pct = usedPercent(snapshot);
  const caution = config.get<number>("cautionThreshold", 80);
  const critical = config.get<number>("criticalThreshold", 100);
  if (pct >= critical) return "🔴 ";
  if (pct >= caution) return "🟡 ";
  return "🟢 ";
}

function countdownShort(endIso: string): string {
  if (!endIso) return "";
  const msLeft = Math.max(0, Date.parse(endIso) - Date.now());
  const days = Math.floor(msLeft / 86400000);
  const hours = Math.floor((msLeft % 86400000) / 3600000);
  if (days > 0) return ` ·${days}d`;
  if (hours > 0) return ` ·${hours}h`;
  return "";
}

function amountText(snapshot: UsageSnapshot, displayFormat: DisplayFormat): string {
  if (snapshot.requestMax && snapshot.requestMax > 0 && snapshot.requestUsed !== null && snapshot.requestUsed !== undefined) {
    const used = snapshot.requestUsed;
    const max = snapshot.requestMax;
    if (displayFormat === "remaining") return `${Math.max(0, max - used)}/${max}`;
    if (displayFormat === "compact") return `${used}/${max}`;
    return `${used}/${max}`;
  }
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents !== null) {
    const used = snapshot.overallUsedCents;
    const limit = snapshot.overallLimitCents;
    if (displayFormat === "remaining") return `${formatCents(Math.max(0, limit - used))} left`;
    if (displayFormat === "compact") return formatCents(used);
    return `${formatCents(used)}/${formatCents(limit)}`;
  }
  const c = formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited);
  const o = formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited);
  if (displayFormat === "compact") return `${c}/${o}`;
  return `C ${c} · O ${o}`;
}

export function formatStatusBar(snapshot: UsageSnapshot, config?: vscode.WorkspaceConfiguration): string {
  const cfg = config ?? vscode.workspace.getConfiguration("cursorTokenUsage");
  const prefix = trafficLight(snapshot, cfg);
  const fmt = cfg.get<StatusBarFormat>("statusBarFormat", "amount");
  const displayFormat = cfg.get<DisplayFormat>("displayFormat", "fraction");
  const partial = snapshot.partialData ? " …" : "";

  if (fmt === "percent") {
    const pct = Math.round(usedPercent(snapshot));
    return `${prefix}${pct}%${partial}`;
  }

  let text = amountText(snapshot, displayFormat);
  if (fmt === "amount_with_reset") text += countdownShort(snapshot.billingCycleEnd);
  if (fmt === "amount_with_plan" && snapshot.planName) text = `${snapshot.planName} ${text}`;
  return `${prefix}${text}${partial}`;
}

export function formatOverviewStatusBar(combined: CombinedViewDto): string {
  const n = combined.perAccountRows.length;
  const tok = formatTokens(combined.totalTokens);
  const hit = formatHitRate(combined.cacheHitRate);
  return vscode.l10n.t("{0} accounts · {1} · cache {2}", n, tok, hit);
}

export function buildOverviewTooltip(combined: CombinedViewDto, lastSuccess?: Date | null): vscode.MarkdownString {
  const lines: string[] = [
    vscode.l10n.t("Cursor Token Usage · Overview"),
    `${vscode.l10n.t("Total Tokens")}: ${formatTokens(combined.totalTokens)}`,
    `${vscode.l10n.t("Cache Hit Rate")}: ${formatHitRate(combined.cacheHitRate)}`,
    tooltipSeparator(),
    tooltipHeaderRow(),
  ];
  for (const r of sortCombinedAccountRows(combined.perAccountRows, { by: "updated" }).slice(0, TOOLTIP_ACCOUNT_ROWS)) {
    lines.push(formatAccountTooltipRow(r));
  }
  const extra = combined.perAccountRows.length - TOOLTIP_ACCOUNT_ROWS;
  if (extra > 0) {
    lines.push(vscode.l10n.t("… +{0} more accounts", extra));
  }
  if (lastSuccess) {
    const sec = Math.max(0, Math.round((Date.now() - lastSuccess.getTime()) / 1000));
    lines.push(vscode.l10n.t("Updated {0}s ago", sec));
  }
  lines.push(vscode.l10n.t("Click to view details"));
  return wrapStatusBarTooltip(lines.filter(Boolean).join("\n"));
}

function wrapStatusBarTooltip(body: string): vscode.MarkdownString {
  const mode =
    vscode.workspace.getConfiguration("cursorTokenUsage").get<string>("statusBarDataSource", "current") === "overview"
      ? "overview"
      : "current";
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.isTrusted = { enabledCommands: ["cursor-token-usage.toggleStatusBarDataSource"] };
  md.appendText(body);
  const modeLabel =
    mode === "overview"
      ? vscode.l10n.t("Status bar: Overview")
      : vscode.l10n.t("Status bar: Current account");
  const action =
    mode === "overview"
      ? vscode.l10n.t("Switch to current account")
      : vscode.l10n.t("Switch to overview");
  md.appendMarkdown(
    `\n\n---\n\n$(swap) ${modeLabel} · [${action}](command:cursor-token-usage.toggleStatusBarDataSource)`,
  );
  return md;
}
function maxOverviewUsagePercent(combined: CombinedViewDto): number {
  let max = 0;
  for (const r of combined.perAccountRows) {
    if (r.overallUsedCents !== null && r.overallLimitCents && r.overallLimitCents > 0) {
      max = Math.max(max, (r.overallUsedCents / r.overallLimitCents) * 100);
    } else {
      max = Math.max(max, r.cursorModelsPercent ?? 0, r.otherModelsPercent ?? 0);
    }
  }
  return max;
}

function asciiBar(pct: number, width = 24): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function buildTooltipLines(
  snapshot: UsageSnapshot,
  opts?: { viewScope?: string; accountCount?: number; lastSuccess?: Date | null },
): vscode.MarkdownString {
  const lines: string[] = [
    `Cursor Token Usage · ${membershipLabel(snapshot.membershipType)}`,
    snapshot.accountLabel ? `${vscode.l10n.t("Account")}: ${snapshot.accountLabel}` : "",
  ];

  if (opts?.viewScope === "all") {
    lines.push(`${vscode.l10n.t("Panel")}: ${vscode.l10n.t("All accounts ({0})", opts.accountCount ?? 0)}`);
  } else if (opts?.viewScope === "account") {
    lines.push(`${vscode.l10n.t("Panel")}: ${vscode.l10n.t("Cached account view")}`);
  }

  if (snapshot.partialData) {
    lines.push(vscode.l10n.t("Partial data — open details to load full cycle"));
  }

  if (snapshot.requestMax && snapshot.requestMax > 0 && snapshot.requestUsed !== null && snapshot.requestUsed !== undefined) {
    const pct = (snapshot.requestUsed / snapshot.requestMax) * 100;
    lines.push(`${vscode.l10n.t("Requests")}: ${snapshot.requestUsed}/${snapshot.requestMax}`);
    lines.push(asciiBar(pct) + ` ${Math.round(pct)}%`);
  } else if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents !== null) {
    const pct = (snapshot.overallUsedCents / snapshot.overallLimitCents) * 100;
    lines.push(`${vscode.l10n.t("Included usage")}: ${formatCents(snapshot.overallUsedCents)}/${formatCents(snapshot.overallLimitCents)}`);
    lines.push(asciiBar(pct) + ` ${Math.round(pct)}%`);
  } else {
    if (snapshot.cursorModelsPercent !== null) {
      lines.push(`Cursor Models: ${formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited)} ${asciiBar(snapshot.cursorModelsPercent)}`);
    }
    if (snapshot.otherModelsPercent !== null) {
      lines.push(`Other Models: ${formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited)} ${asciiBar(snapshot.otherModelsPercent)}`);
    }
  }

  if (snapshot.billingCycleEnd) {
    const msLeft = Math.max(0, Date.parse(snapshot.billingCycleEnd) - Date.now());
    const days = Math.floor(msLeft / 86400000);
    const hours = Math.floor((msLeft % 86400000) / 3600000);
    lines.push(vscode.l10n.t("Reset in: {0}d {1}h", days, hours));
  }

  if (snapshot.onDemandEnabled && snapshot.onDemandUsedCents !== null) {
    lines.push(
      `On-Demand: ${formatCents(snapshot.onDemandUsedCents)}${
        snapshot.onDemandLimitCents && snapshot.onDemandLimitCents > 0 ? `/${formatCents(snapshot.onDemandLimitCents)}` : ""
      }`,
    );
  }

  lines.push(`${vscode.l10n.t("Total Tokens")}: ${formatTokens(snapshot.totalTokens)}`);
  if (opts?.lastSuccess) {
    const sec = Math.max(0, Math.round((Date.now() - opts.lastSuccess.getTime()) / 1000));
    lines.push(vscode.l10n.t("Updated {0}s ago", sec));
  }
  lines.push(vscode.l10n.t("Click to view details"));
  return wrapStatusBarTooltip(lines.filter(Boolean).join("\n"));
}

export function usageRatio(snapshot: UsageSnapshot): number | null {
  const pct = usedPercent(snapshot);
  return Number.isFinite(pct) ? pct / 100 : null;
}

export function applyStatusBarColors(
  item: vscode.StatusBarItem,
  snapshot: UsageSnapshot,
  config?: vscode.WorkspaceConfiguration,
  combined?: CombinedViewDto | null,
): void {
  const cfg = config ?? vscode.workspace.getConfiguration("cursorTokenUsage");
  const caution = cfg.get<number>("cautionThreshold", 80) / 100;
  const critical = cfg.get<number>("criticalThreshold", 100) / 100;
  let pct: number;
  if (combined && combined.perAccountRows.length > 0) {
    pct = maxOverviewUsagePercent(combined) / 100;
  } else {
    const ratio = usageRatio(snapshot);
    pct = ratio ?? 0;
  }
  if (!snapshot.isUnlimited && pct >= critical) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
  } else if (!snapshot.isUnlimited && pct >= caution) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    item.color = new vscode.ThemeColor("statusBarItem.warningForeground");
  } else {
    item.backgroundColor = undefined;
    item.color = undefined;
  }
}
