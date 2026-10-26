import * as vscode from "vscode";
import { formatCompactNumber } from "./formatNumber";

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
