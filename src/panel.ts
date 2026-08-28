import * as vscode from "vscode";
import { UsageSnapshot } from "./models";
import { formatCents, formatEventTime, formatPct, formatTokens, isZh, membershipLabel, shortenModel } from "./treeView";

export class UsagePanel {
  public static current: UsagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly getSnapshot: () => UsageSnapshot | null;
  private readonly getError: () => string | null;

  static show(
    context: vscode.ExtensionContext,
    getSnapshot: () => UsageSnapshot | null,
    getError: () => string | null,
    onMessage: (command: string) => void,
  ): UsagePanel {
    if (UsagePanel.current) {
      UsagePanel.current.refresh();
      UsagePanel.current.panel.reveal();
      return UsagePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "cursorTokenUsage",
      vscode.l10n.t("Cursor Token Usage"),
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    UsagePanel.current = new UsagePanel(panel, getSnapshot, getError, onMessage);
    context.subscriptions.push(panel);
    return UsagePanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    getSnapshot: () => UsageSnapshot | null,
    getError: () => string | null,
    onMessage: (command: string) => void,
  ) {
    this.panel = panel;
    this.getSnapshot = getSnapshot;
    this.getError = getError;
    this.refresh();
    panel.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg.command) onMessage(msg.command);
    });
    panel.onDidDispose(() => {
      if (UsagePanel.current === this) UsagePanel.current = undefined;
    });
  }

  refresh(): void {
    this.panel.title = vscode.l10n.t("Cursor Token Usage");
    this.panel.webview.html = renderHtml(this.panel.webview, this.getSnapshot(), this.getError());
  }

  markStale(): void {
    void this.panel.webview.postMessage({ command: "stale" });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function barColor(pct: number): string {
  if (pct >= 100) return "var(--err)";
  if (pct >= 80) return "var(--warn)";
  if (pct >= 40) return "var(--mid)";
  return "var(--ok)";
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

function meter(label: string, valueText: string, pct: number, unlimited = false): string {
  const width = unlimited ? 100 : clampPct(pct);
  const color = unlimited ? "var(--ok)" : barColor(pct);
  const pctLabel = formatPct(pct, unlimited);
  return `<div class="meter">
    <div class="meter-head"><span>${escapeHtml(label)}</span><strong>${escapeHtml(valueText)}</strong></div>
    <div class="track"><div class="fill" style="width:${width}%;background:${color}"></div></div>
    <div class="meter-pct" style="color:${color}">${escapeHtml(pctLabel)}</div>
  </div>`;
}

function ring(pct: number, headline: string, sub: string, unlimited: boolean): string {
  const r = 54;
  const c = 2 * Math.PI * r;
  const p = unlimited ? 0 : clampPct(pct);
  const offset = unlimited ? 0 : c * (1 - p / 100);
  const color = unlimited ? "var(--ok)" : barColor(pct);
  const center = formatPct(pct, unlimited);
  return `<div class="hero">
    <div class="ring-wrap">
      <svg viewBox="0 0 128 128" class="ring">
        <circle class="ring-bg" cx="64" cy="64" r="${r}"></circle>
        <circle class="ring-fg" cx="64" cy="64" r="${r}" stroke="${color}"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
      </svg>
      <div class="ring-center" style="color:${color}">${escapeHtml(center)}</div>
    </div>
    <div class="hero-copy">
      <div class="hero-kicker">${escapeHtml(vscode.l10n.t("Included usage"))}</div>
      <div class="hero-main">${escapeHtml(headline)}</div>
      <div class="hero-sub">${escapeHtml(sub)}</div>
    </div>
  </div>`;
}

function countdown(endIso: string): string {
  if (!endIso) return "";
  const msLeft = Math.max(0, Date.parse(endIso) - Date.now());
  const totalSeconds = Math.ceil(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  let text: string;
  if (days > 0) text = vscode.l10n.t("{0}d {1}h", days, hours);
  else if (hours > 0) text = vscode.l10n.t("{0}h {1}m", hours, minutes);
  else text = vscode.l10n.t("{0}m {1}s", minutes, totalSeconds % 60);
  return vscode.l10n.t("Reset in: {0}", text);
}

function heroPct(snapshot: UsageSnapshot): number {
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents && snapshot.overallLimitCents > 0) {
    return (snapshot.overallUsedCents / snapshot.overallLimitCents) * 100;
  }
  return Math.max(snapshot.cursorModelsPercent ?? 0, snapshot.otherModelsPercent ?? 0);
}

function eventMs(ts: number): number {
  return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
}

function dayKey(ts: number): string {
  const d = new Date(eventMs(ts));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoDay(value: string): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return dayKey(ms);
}

function trendRange(snapshot: UsageSnapshot, eventDays: string[]): { minDay: string; maxDay: string } {
  const today = dayKey(Date.now());
  const cycleStart = isoDay(snapshot.billingCycleStart);
  const cycleEnd = isoDay(snapshot.billingCycleEnd);
  const firstEvent = eventDays[0] || today;
  const lastEvent = eventDays[eventDays.length - 1] || today;
  const minDay = cycleStart || firstEvent;
  const maxDay = cycleEnd && cycleEnd < today ? cycleEnd : today;
  if (minDay <= maxDay) return { minDay, maxDay };
  return { minDay: firstEvent, maxDay: lastEvent };
}

function renderTrend(snapshot: UsageSnapshot): string {
  const points = snapshot.events
    .filter((e) => e.timestamp)
    .map((e) => ({
      day: dayKey(e.timestamp),
      model: e.model,
      input: e.inputTokens,
      output: e.outputTokens,
      cache: e.cacheWriteTokens + e.cacheReadTokens,
      tokens: e.totalTokens,
      cents: e.totalCents,
    }));
  if (points.length === 0) {
    return `<p class="empty">${escapeHtml(vscode.l10n.t("Not enough event data for a trend"))}</p>`;
  }
  const models = [...new Set(points.map((p) => p.model))].sort();
  const eventDays = [...new Set(points.map((p) => p.day))].sort();
  const { minDay, maxDay } = trendRange(snapshot, eventDays);
  const payload = JSON.stringify({ points, models, minDay, maxDay }).replace(/</g, "\\u003c");
  const modelOpts = [`<option value="">${escapeHtml(vscode.l10n.t("All models"))}</option>`]
    .concat(models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(shortenModel(m))}</option>`))
    .join("");
  return `
    <div class="trend-head">
      <div class="tabs">
        <button type="button" class="tab on" data-metric="token">${escapeHtml(vscode.l10n.t("Token"))}</button>
        <button type="button" class="tab" data-metric="cost">${escapeHtml(vscode.l10n.t("Cost"))}</button>
      </div>
      <div class="trend-filters">
        <label>${escapeHtml(vscode.l10n.t("From"))} <input type="date" id="trend-from" min="${minDay}" max="${maxDay}" value="${minDay}"></label>
        <label>${escapeHtml(vscode.l10n.t("To"))} <input type="date" id="trend-to" min="${minDay}" max="${maxDay}" value="${maxDay}"></label>
        <select id="trend-model">${modelOpts}</select>
      </div>
    </div>
    <p class="trend-range" id="trend-range">${escapeHtml(vscode.l10n.t("Detail range: {0} ~ {1} | Metric: {2}", minDay, maxDay, vscode.l10n.t("Token")))}</p>
    <div id="trend-chart" class="chart-wrap"><div id="chart-tip" class="chart-tip" hidden></div></div>
    <p class="legend" id="trend-legend"></p>
    <script type="application/json" id="trend-data">${payload}</script>
    <span hidden id="trend-i18n"
      data-token="${escapeHtml(vscode.l10n.t("Token"))}"
      data-wan="${isZh() ? "1" : "0"}"
      data-cost="${escapeHtml(vscode.l10n.t("Cost"))}"
      data-range="${escapeHtml(vscode.l10n.t("Detail range: {0} ~ {1} | Metric: {2}", "{0}", "{1}", "{2}"))}"
      data-nocost="${escapeHtml(vscode.l10n.t("API did not return cost"))}"
      data-empty="${escapeHtml(vscode.l10n.t("Not enough event data for a trend"))}"
      data-input="${escapeHtml(vscode.l10n.t("Input"))}"
      data-output="${escapeHtml(vscode.l10n.t("Output"))}"
      data-cache="${escapeHtml(vscode.l10n.t("Cache"))}"
      data-line="${escapeHtml(vscode.l10n.t("Trend line"))}"
      data-total="${escapeHtml(vscode.l10n.t("Total"))}"></span>`;
}

function heroHeadline(snapshot: UsageSnapshot): string {
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents !== null) {
    return `${formatCents(snapshot.overallUsedCents)} / ${formatCents(snapshot.overallLimitCents)}`;
  }
  const c = formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited);
  const o = formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited);
  return `C ${c}  ·  O ${o}`;
}

function renderHtml(webview: vscode.Webview, snapshot: UsageSnapshot | null, error: string | null): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const actions = `
    <div class="actions">
      <button data-cmd="refresh">${escapeHtml(vscode.l10n.t("Refresh Token Usage"))}</button>
      <button data-cmd="token">${escapeHtml(vscode.l10n.t("Set Session Token"))}</button>
      <button data-cmd="align">${escapeHtml(vscode.l10n.t("Status bar side"))}</button>
      <button data-cmd="alerts">${escapeHtml(vscode.l10n.t("Configure Usage Alerts"))}</button>
    </div>`;

  let body: string;
  if (!snapshot) {
    const needToken = !!error && /session token/i.test(error);
    body = `<div class="empty-box">
      <p class="empty">${escapeHtml(error || vscode.l10n.t("Loading..."))}</p>
      ${needToken ? `<p class="empty">${escapeHtml(vscode.l10n.t("Need a Session Token to load usage"))}</p>` : ""}
    </div>${actions}`;
  } else {
    const meters: string[] = [];
    if (snapshot.overallUsedCents !== null && snapshot.overallLimitCents && snapshot.overallLimitCents > 0) {
      const pct = (snapshot.overallUsedCents / snapshot.overallLimitCents) * 100;
      meters.push(meter(
        vscode.l10n.t("Included usage"),
        `${formatCents(snapshot.overallUsedCents)} / ${formatCents(snapshot.overallLimitCents)}`,
        pct,
        snapshot.isUnlimited,
      ));
    }
    if (snapshot.displayMode !== "overall") {
      if (snapshot.cursorModelsPercent !== null) {
        meters.push(meter(vscode.l10n.t("Cursor Models"), formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited), snapshot.cursorModelsPercent, snapshot.isUnlimited));
      }
      if (snapshot.otherModelsPercent !== null) {
        meters.push(meter(vscode.l10n.t("Other Models"), formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited), snapshot.otherModelsPercent, snapshot.isUnlimited));
      }
    }
    if ((snapshot.onDemandEnabled || /enterprise|team/i.test(snapshot.membershipType)) && snapshot.onDemandUsedCents !== null) {
      const limit = snapshot.onDemandLimitCents && snapshot.onDemandLimitCents > 0 ? snapshot.onDemandLimitCents : null;
      const pct = limit ? (snapshot.onDemandUsedCents / limit) * 100 : 0;
      const text = limit
        ? `${formatCents(snapshot.onDemandUsedCents)} / ${formatCents(limit)}`
        : formatCents(snapshot.onDemandUsedCents);
      meters.push(meter(vscode.l10n.t("On-Demand"), text, pct));
    }

    const totalTok = Math.max(1, snapshot.totalTokens);
    const models = snapshot.aggregations.slice(0, 12).map((a) => {
      const share = (a.totalTokens / totalTok) * 100;
      return `<div class="row clickable" data-filter-model="${escapeHtml(a.model)}" title="${escapeHtml(a.model)}">
        <span class="name">${escapeHtml(shortenModel(a.model))}</span>
        <div class="mini-track"><div class="fill" style="width:${clampPct(share)}%"></div></div>
        <span class="num">${escapeHtml(formatTokens(a.totalTokens))}<small>${escapeHtml(vscode.l10n.t("{0} of total", `${Math.round(share)}%`))}</small></span>
      </div>`;
    }).join("");

    const displayCount = vscode.workspace.getConfiguration("cursorTokenUsage").get<number>("displayCount", 5);
    const visibleEvents = snapshot.events.slice(0, displayCount);
    const events = visibleEvents.map((e) => {
      const onDemand = e.kind.includes("USAGE_BASED");
      const badge = onDemand ? vscode.l10n.t("On-Demand") : vscode.l10n.t("Included");
      return `<tr class="clickable" data-filter-model="${escapeHtml(e.model)}">
        <td>${escapeHtml(formatEventTime(e.timestamp))}</td>
        <td>${escapeHtml(shortenModel(e.model))}</td>
        <td><span class="badge ${onDemand ? "od" : "inc"}">${badge}</span></td>
        <td class="num">${escapeHtml(formatTokens(e.totalTokens))}</td>
      </tr>`;
    }).join("");

    body = `
      <header>
        <div>
          <h1>${escapeHtml(vscode.l10n.t("Cursor Token Usage"))}</h1>
          <p class="sub">
            <span class="chip">${escapeHtml(membershipLabel(snapshot.membershipType))}</span>
            ${escapeHtml(countdown(snapshot.billingCycleEnd))}
          </p>
        </div>
        <div class="stat-pill">${escapeHtml(vscode.l10n.t("Total Tokens"))}<strong>${escapeHtml(formatTokens(snapshot.totalTokens))}</strong></div>
      </header>
      ${ring(heroPct(snapshot), heroHeadline(snapshot), countdown(snapshot.billingCycleEnd), snapshot.isUnlimited)}
      ${actions}
      <section><h2>${escapeHtml(vscode.l10n.t("Usage Trend"))}</h2>${renderTrend(snapshot)}</section>
      <section><h2>${escapeHtml(vscode.l10n.t("Billing Cycle"))}</h2>${meters.join("") || `<p class="empty">${escapeHtml(vscode.l10n.t("No data"))}</p>`}</section>
      <section><h2>${escapeHtml(vscode.l10n.t("By Model ({0})", snapshot.aggregations.length))}</h2>
        <p class="hint">${escapeHtml(vscode.l10n.t("Click a model row to filter the trend"))}</p>
        ${models || `<p class="empty">${escapeHtml(vscode.l10n.t("No data"))}</p>`}</section>
      <section><h2>${escapeHtml(vscode.l10n.t("Recent Usage ({0} entries)", visibleEvents.length))}</h2>
        <table><thead><tr><th>${escapeHtml(vscode.l10n.t("Time"))}</th><th>${escapeHtml(vscode.l10n.t("Model"))}</th><th>${escapeHtml(vscode.l10n.t("Kind"))}</th><th>${escapeHtml(vscode.l10n.t("Tokens"))}</th></tr></thead><tbody>${events}</tbody></table>
      </section>`;
  }

  return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language || "en")}">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
:root {
  --bg: var(--vscode-editor-background);
  --card: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
  --line: var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  --text: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --ok: var(--vscode-charts-green, #89d185);
  --mid: var(--vscode-charts-yellow, #e2c08d);
  --warn: var(--vscode-charts-orange, #d18616);
  --err: var(--vscode-errorForeground, #f85149);
  --accent: var(--vscode-textLink-foreground);
  --hover: var(--vscode-list-hoverBackground);
  --in: var(--vscode-charts-blue, #4da3ff);
  --out: var(--vscode-charts-green, #89d185);
  --cache: var(--vscode-charts-orange, #d18616);
  --linec: var(--vscode-charts-purple, #b180d7);
  --costc: var(--vscode-charts-blue, #4da3ff);
  --track: color-mix(in srgb, var(--text) 12%, transparent);
}
html, body {
  margin: 0; padding: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  color-scheme: light dark;
}
.wrap { max-width: 760px; margin: 0 auto; padding: 20px 18px 36px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
header h1 { margin: 0; font-size: 20px; letter-spacing: .01em; }
.sub { margin: 6px 0 0; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.chip {
  display: inline-block; padding: 1px 8px; border-radius: 99px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
}
.stat-pill { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; color: var(--muted); min-width: 110px; }
.stat-pill strong { display: block; color: var(--text); font-size: 16px; }
.hero {
  display: flex; gap: 20px; align-items: center; margin: 18px 0 8px;
  background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px;
}
.ring-wrap { position: relative; width: 128px; height: 128px; flex: 0 0 128px; }
.ring { width: 128px; height: 128px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--line); stroke-width: 10; }
.ring-fg { fill: none; stroke-width: 10; stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
.ring-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 700; }
.hero-kicker { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.hero-main { font-size: 22px; font-weight: 700; margin: 4px 0; font-variant-numeric: tabular-nums; }
.hero-sub { color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, var(--line));
  border-radius: 8px; padding: 6px 12px; cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--hover)); }
section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin: 12px 0; }
h2 { margin: 0 0 8px; font-size: 12px; color: var(--muted); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.hint { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
.meter { margin: 0 -8px 8px; padding: 8px; border-radius: 8px; transition: background .15s; }
.meter:hover { background: var(--hover); }
.meter-head { display: flex; justify-content: space-between; margin-bottom: 6px; }
.meter-pct { text-align: right; font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.track, .mini-track { height: 10px; background: var(--track); border-radius: 99px; overflow: hidden; }
.fill { height: 100%; border-radius: 99px; background: var(--ok); position: relative; transition: width .5s ease; }
.row { display: grid; grid-template-columns: 150px 1fr 110px; gap: 10px; align-items: center; margin: 4px -8px; padding: 6px 8px; border-radius: 8px; }
.name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num small { display: block; color: var(--muted); font-size: 11px; }
.clickable { cursor: pointer; }
.clickable:hover, tr.clickable:hover td { background: var(--hover); }
.trend-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.tabs { display: flex; gap: 16px; }
.tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); padding: 4px 0; cursor: pointer; border-radius: 0; }
.tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.tab:hover { color: var(--text); }
.trend-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.trend-filters label { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.trend-filters input[type="date"], #trend-model {
  background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; color-scheme: inherit;
}
.trend-range { color: var(--muted); margin: 0 0 10px; font-size: 12px; }
.chart-wrap { position: relative; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 8px 4px; min-height: 220px; }
.chart-wrap svg { width: 100%; height: 220px; display: block; }
.chart-tip {
  position: absolute; pointer-events: none; z-index: 5;
  background: var(--vscode-editorHoverWidget-background, var(--card));
  color: var(--vscode-editorHoverWidget-foreground, var(--text));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--line));
  border-radius: 6px; padding: 8px 10px; font-size: 12px; white-space: nowrap;
  box-shadow: 0 6px 18px color-mix(in srgb, #000 18%, transparent);
}
.chart-tip strong { display: block; margin-bottom: 4px; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; margin: 10px 0 0; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 99px; margin-right: 4px; }
.dot.in { background: var(--in); }
.dot.out { background: var(--out); }
.dot.cache { background: var(--cache); }
.dot.line { background: var(--linec); }
.dot.cost { background: var(--costc); }
.chart-empty { color: var(--muted); padding: 40px 12px; text-align: center; }
.stale-banner {
  margin: 0 0 12px; padding: 8px 12px; border-radius: 8px; font-size: 12px;
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--text); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
}
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 4px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; }
.badge { font-size: 11px; border-radius: 99px; padding: 1px 8px; }
.badge.inc { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.badge.od { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.empty { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
<p class="stale-banner" id="stale-banner" hidden>${escapeHtml(vscode.l10n.t("Status bar updated. Click Refresh for details."))}</p>
${body}
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
window.addEventListener("message", (event) => {
  const banner = document.getElementById("stale-banner");
  if (banner && event.data && event.data.command === "stale") banner.hidden = false;
});
for (const btn of document.querySelectorAll("[data-cmd]")) {
  btn.addEventListener("click", () => vscode.postMessage({ command: btn.dataset.cmd }));
}
(function () {
  const dataEl = document.getElementById("trend-data");
  const chartEl = document.getElementById("trend-chart");
  if (!dataEl || !chartEl) return;
  const i18n = document.getElementById("trend-i18n");
  const tpl = (i18n && i18n.dataset.range) || "{0} ~ {1} | {2}";
  const fmt = (s, a, b, c) => s.replace("{0}", a).replace("{1}", b).replace("{2}", c);
  const payload = JSON.parse(dataEl.textContent || "{}");
  const points = payload.points || [];
  const minDay = payload.minDay || "";
  const maxDay = payload.maxDay || "";
  const saved = (typeof vscode.getState === "function" && vscode.getState()) || {};
  let metric = saved.metric === "cost" ? "cost" : "token";
  let model = typeof saved.model === "string" ? saved.model : "";
  function isoAdd(iso, n) {
    const parts = iso.split("-").map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2] + n);
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  }
  function clampDay(d) {
    if (!d) return minDay;
    if (minDay && d < minDay) return minDay;
    if (maxDay && d > maxDay) return maxDay;
    return d;
  }
  function last7() {
    return clampDay(isoAdd(maxDay, -6));
  }
  let from = saved.from && saved.from >= minDay && saved.from <= maxDay ? saved.from : last7();
  let to = saved.to && saved.to >= minDay && saved.to <= maxDay ? saved.to : maxDay;
  if (from > to) { from = last7(); to = maxDay; }

  function persist() {
    if (typeof vscode.setState === "function") vscode.setState({ metric, model, from, to });
  }
  function eachDay(a, b) {
    const out = [];
    if (!a || !b || a > b) return out;
    for (let d = a, i = 0; d <= b && i < 400; d = isoAdd(d, 1), i++) out.push(d);
    return out;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / p) * p;
  }
  function fmtNum(v, cost) {
    if (cost) return "$" + (v / 100).toFixed(2);
    const wan = i18n && i18n.dataset.wan === "1";
    if (wan && v >= 10000) return (v / 10000).toFixed(v >= 1e6 ? 0 : 1) + "万";
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + "K";
    return String(Math.round(v));
  }
  function spline(pts) {
    if (pts.length < 2) return "";
    let d = "M " + pts[0][0] + " " + pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      d += " C " + (p1[0] + (p2[0] - p0[0]) / 6) + " " + (p1[1] + (p2[1] - p0[1]) / 6) + ", "
        + (p2[0] - (p3[0] - p1[0]) / 6) + " " + (p2[1] - (p3[1] - p1[1]) / 6) + ", "
        + p2[0] + " " + p2[1];
    }
    return d;
  }
  function aggregate() {
    const filtered = model ? points.filter((p) => p.model === model) : points;
    const map = {};
    for (const p of filtered) {
      if (!map[p.day]) map[p.day] = { day: p.day, input: 0, output: 0, cache: 0, tokens: 0, cents: 0 };
      map[p.day].input += p.input;
      map[p.day].output += p.output;
      map[p.day].cache += p.cache;
      map[p.day].tokens += p.tokens;
      map[p.day].cents += p.cents;
    }
    return eachDay(from, to).map((day) => map[day] || { day, input: 0, output: 0, cache: 0, tokens: 0, cents: 0 });
  }
  function hideTip() {
    const tip = document.getElementById("chart-tip");
    if (tip) tip.hidden = true;
  }
  function showTip(ev, html) {
    let tip = document.getElementById("chart-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "chart-tip";
      tip.className = "chart-tip";
      chartEl.appendChild(tip);
    }
    tip.hidden = false;
    tip.innerHTML = html;
    const r = chartEl.getBoundingClientRect();
    const tw = tip.offsetWidth || 160;
    const th = tip.offsetHeight || 80;
    let x = ev.clientX - r.left + 12;
    let y = ev.clientY - r.top + 12;
    if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 8;
    if (y + th > r.height - 8) y = ev.clientY - r.top - th - 8;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function tipHtml(d) {
    const inputL = (i18n && i18n.dataset.input) || "Input";
    const outputL = (i18n && i18n.dataset.output) || "Output";
    const cacheL = (i18n && i18n.dataset.cache) || "Cache";
    const totalL = (i18n && i18n.dataset.total) || "Total";
    const costL = (i18n && i18n.dataset.cost) || "Cost";
    if (metric === "cost") {
      return "<strong>" + d.day + "</strong>" + costL + ": " + fmtNum(d.cents, true);
    }
    return "<strong>" + d.day + "</strong>"
      + totalL + ": " + fmtNum(d.tokens, false) + "<br>"
      + inputL + ": " + fmtNum(d.input, false) + "<br>"
      + outputL + ": " + fmtNum(d.output, false) + "<br>"
      + cacheL + ": " + fmtNum(d.cache, false);
  }
  function updateLegend() {
    const el = document.getElementById("trend-legend");
    if (!el) return;
    const inputL = (i18n && i18n.dataset.input) || "Input";
    const outputL = (i18n && i18n.dataset.output) || "Output";
    const cacheL = (i18n && i18n.dataset.cache) || "Cache";
    const lineL = (i18n && i18n.dataset.line) || "Trend";
    const costL = (i18n && i18n.dataset.cost) || "Cost";
    if (metric === "cost") {
      el.innerHTML = '<span class="dot cost"></span>' + costL + ' <span class="dot line"></span>' + lineL;
    } else {
      el.innerHTML = '<span class="dot in"></span>' + inputL
        + ' <span class="dot out"></span>' + outputL
        + ' <span class="dot cache"></span>' + cacheL
        + ' <span class="dot line"></span>' + lineL;
    }
  }
  function render() {
    persist();
    updateLegend();
    const days = aggregate();
    const rangeEl = document.getElementById("trend-range");
    const metricLabel = metric === "cost" ? ((i18n && i18n.dataset.cost) || "Cost") : ((i18n && i18n.dataset.token) || "Token");
    if (rangeEl) rangeEl.textContent = fmt(tpl, from || "—", to || "—", metricLabel);
    hideTip();
    if (!days.length) {
      chartEl.innerHTML = '<p class="chart-empty">' + ((i18n && i18n.dataset.empty) || "") + "</p>";
      return;
    }
    if (metric === "cost" && !days.some((d) => d.cents > 0)) {
      chartEl.innerHTML = '<p class="chart-empty">' + ((i18n && i18n.dataset.nocost) || "") + "</p>";
      return;
    }
    const W = 640, H = 220, L = 52, R = 8, T = 12, B = 32;
    const plotW = W - L - R, plotH = H - T - B;
    const maxRaw = metric === "cost" ? Math.max(...days.map((d) => d.cents)) : Math.max(...days.map((d) => d.tokens));
    const maxY = niceMax(maxRaw);
    const n = days.length;
    const slot = plotW / n;
    const barW = Math.min(28, Math.max(6, slot * 0.55));
    const labelStep = n > 14 ? Math.ceil(n / 8) : 1;
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => maxY * t);
    let grid = "";
    for (const t of yTicks) {
      const y = T + plotH - (t / maxY) * plotH;
      grid += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="var(--line)" stroke-dasharray="3 3"/>';
      grid += '<text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="var(--muted)">' + fmtNum(t, metric === "cost") + "</text>";
    }
    let bars = "";
    let hits = "";
    const linePts = [];
    days.forEach((d, i) => {
      const x = L + slot * i + (slot - barW) / 2;
      if (metric === "cost") {
        const h = (d.cents / maxY) * plotH;
        bars += '<rect x="' + x + '" y="' + (T + plotH - h) + '" width="' + barW + '" height="' + Math.max(h, 1) + '" fill="var(--costc)" rx="2"/>';
        linePts.push([x + barW / 2, T + plotH - h]);
      } else {
        const hIn = (d.input / maxY) * plotH;
        const hOut = (d.output / maxY) * plotH;
        const hCache = (d.cache / maxY) * plotH;
        let y = T + plotH;
        y -= hIn; bars += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + Math.max(hIn, 0) + '" fill="var(--in)"/>';
        y -= hOut; bars += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + Math.max(hOut, 0) + '" fill="var(--out)"/>';
        y -= hCache; bars += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + Math.max(hCache, 0) + '" fill="var(--cache)"/>';
        linePts.push([x + barW / 2, y]);
      }
      const hitX = L + slot * i;
      hits += '<rect class="hit" data-i="' + i + '" x="' + hitX + '" y="' + T + '" width="' + slot + '" height="' + plotH + '" fill="transparent"/>';
      if (i % labelStep === 0 || i === n - 1) {
        bars += '<text x="' + (x + barW / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="var(--muted)">' + d.day.slice(5) + "</text>";
      }
    });
    const line = '<path d="' + spline(linePts) + '" fill="none" stroke="var(--linec)" stroke-width="2" pointer-events="none"/>';
    chartEl.innerHTML = '<div id="chart-tip" class="chart-tip" hidden></div><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + bars + line + hits + "</svg>";
    chartEl.querySelectorAll(".hit").forEach((el) => {
      const i = Number(el.getAttribute("data-i"));
      el.addEventListener("mousemove", (ev) => showTip(ev, tipHtml(days[i])));
      el.addEventListener("mouseleave", hideTip);
    });
  }
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("on", btn.getAttribute("data-metric") === metric);
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      metric = btn.getAttribute("data-metric") || "token";
      render();
    });
  });
  const sel = document.getElementById("trend-model");
  if (sel) {
    if (model && [...sel.options].some((o) => o.value === model)) sel.value = model;
    else model = "";
    sel.addEventListener("change", () => { model = sel.value; render(); });
  }
  const fromEl = document.getElementById("trend-from");
  const toEl = document.getElementById("trend-to");
  if (fromEl) { fromEl.value = from; fromEl.addEventListener("change", () => { from = fromEl.value || minDay; if (to && from > to) from = to; fromEl.value = from; render(); }); }
  if (toEl) { toEl.value = to; toEl.addEventListener("change", () => { to = toEl.value || maxDay; if (from && to < from) to = from; toEl.value = to; render(); }); }
  document.querySelectorAll("[data-filter-model]").forEach((el) => {
    el.addEventListener("click", () => {
      const v = el.getAttribute("data-filter-model") || "";
      if (!sel) return;
      if ([...sel.options].some((o) => o.value === v)) {
        sel.value = v;
        model = v;
        render();
        chartEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
  render();
})();
</script>
</body>
</html>`;
}
