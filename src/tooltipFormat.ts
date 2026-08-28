import * as vscode from "vscode";
import { formatHitRate } from "./cacheStats";
import { CombinedAccountRow } from "./models";
import { formatPct, formatTokens } from "./treeView";

const SEP = " │ ";

export function shortenTooltipLabel(label: string, max = 16): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

function poolUsage(r: CombinedAccountRow): string {
  if (r.overallUsedCents !== null && r.overallLimitCents !== null) {
    return `$${(r.overallUsedCents / 100).toFixed(2)}/$${(r.overallLimitCents / 100).toFixed(2)}`;
  }
  return `${formatPct(r.cursorModelsPercent, false)}/${formatPct(r.otherModelsPercent, false)}`;
}

export function formatAccountTooltipRow(r: CombinedAccountRow): string {
  const stale = r.isStale ? ` ${vscode.l10n.t("(cached)")}` : "";
  return [
    shortenTooltipLabel(r.label),
    formatTokens(r.totalTokens),
    poolUsage(r),
    formatHitRate(r.cacheHitRate),
  ].join(SEP) + stale;
}

export function tooltipSeparator(width = 28): string {
  return "─".repeat(width);
}

export function tooltipHeaderRow(): string {
  return [
    vscode.l10n.t("Account"),
    vscode.l10n.t("Tokens"),
    vscode.l10n.t("Pool %"),
    vscode.l10n.t("Cache Hit"),
  ].join(SEP);
}
