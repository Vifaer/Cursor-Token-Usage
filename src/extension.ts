/**
 * Cursor Token Usage — status-bar usage for Cursor token billing.
 * Individual accounts: two pool percentages. Team/Enterprise: included spend vs limit.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { initStore, listAccountSnapshots } from "./accountStore";
import { deleteSecretToken, getSecretToken, initSecretStorage, storeSecretToken } from "./api";
import { runDiagnoseAuth, setExtensionPath } from "./credentials";
import { CombinedViewDto, UsageAlert, UsageSnapshot, isCombinedView } from "./models";
import { UsagePanel } from "./panel";
import { applyStatusBarColors, buildOverviewTooltip, buildTooltipLines, formatOverviewStatusBar, formatStatusBar } from "./render";
import { UsageTracker } from "./tracker";
import { formatTokens } from "./treeView";

let pollTimer: NodeJS.Timeout | undefined;
let tracker: UsageTracker;
let mainStatusBar: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let windowFocused = true;
let suppressStale = false;

export function activate(context: vscode.ExtensionContext): void {
  initSecretStorage(context.secrets);
  initStore(context);
  setExtensionPath(context.extensionPath);
  extensionContext = context;
  tracker = new UsageTracker();
  tracker.hydrateFromStore();

  recreateStatusBar();

  tracker.onUpdate = () => {
    updateStatusBar();
    if (!suppressStale) UsagePanel.current?.markStale(tracker.lastSuccessTime);
  };
  tracker.onAlert = (alerts) => showAlerts(alerts);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursor-token-usage.showDetails", showDetails),
    vscode.commands.registerCommand("cursor-token-usage.refresh", refresh),
    vscode.commands.registerCommand("cursor-token-usage.setToken", setToken),
    vscode.commands.registerCommand("cursor-token-usage.setPollingInterval", setPollingInterval),
    vscode.commands.registerCommand("cursor-token-usage.setStatusBarAlignment", setStatusBarAlignment),
    vscode.commands.registerCommand("cursor-token-usage.configureAlerts", configureAlerts),
    vscode.commands.registerCommand("cursor-token-usage.diagnoseAuth", diagnoseAuth),
    vscode.commands.registerCommand("cursor-token-usage.switchAccountView", switchAccountView),
    vscode.commands.registerCommand("cursor-token-usage.exportUsage", exportUsage),
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
      startPolling();
      if (state.focused) void tracker.poll();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cursorTokenUsage.pollingInterval")) startPolling();
      if (e.affectsConfiguration("cursorTokenUsage.statusBarAlignment")) recreateStatusBar();
      else if (e.affectsConfiguration("cursorTokenUsage")) updateStatusBar();
    }),
  );

  void tracker.poll(true);
  startPolling();
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = vscode.workspace.getConfiguration("cursorTokenUsage").get<number>("pollingInterval", 30);
  const interval = windowFocused ? Math.max(5, seconds) : Math.max(90, seconds);
  pollTimer = setInterval(() => {
    void tracker.poll();
  }, interval * 1000);
}

async function refresh(): Promise<void> {
  suppressStale = true;
  if (mainStatusBar) mainStatusBar.text = `$(graph) Token …`;
  try {
    await tracker.poll(true, { fullEvents: !!UsagePanel.current });
    UsagePanel.current?.refresh();
  } finally {
    suppressStale = false;
  }
}

function recreateStatusBar(): void {
  mainStatusBar?.dispose();
  const side = vscode.workspace.getConfiguration("cursorTokenUsage").get<string>("statusBarAlignment", "right");
  const alignment = side === "left" ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
  // High priority so the item stays visible (not buried in status-bar overflow "…")
  mainStatusBar = vscode.window.createStatusBarItem(alignment, 1000);
  mainStatusBar.name = "Cursor Token Usage";
  mainStatusBar.command = "cursor-token-usage.showDetails";
  mainStatusBar.text = `$(graph) Token`;
  mainStatusBar.tooltip = vscode.l10n.t("Click to view details");
  mainStatusBar.accessibilityInformation = {
    label: "Cursor Token Usage",
    role: "button",
  };
  mainStatusBar.show();
  extensionContext.subscriptions.push(mainStatusBar);
  updateStatusBar();
}

function updateStatusBar(): void {
  if (!mainStatusBar) return;
  const showMain = vscode.workspace.getConfiguration("cursorTokenUsage").get("showStatusBar", true);
  if (!showMain) {
    mainStatusBar.hide();
    return;
  }
  mainStatusBar.show();

  const snapshot = tracker.lastSnapshot;
  if (!snapshot) {
    const err = tracker.lastError;
    const needToken = isTokenError(err);
    mainStatusBar.text = needToken
      ? `$(key) Token`
      : err
        ? `$(warning) Token`
        : `$(graph) Token …`;
    mainStatusBar.backgroundColor = err
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    mainStatusBar.color = err
      ? new vscode.ThemeColor("statusBarItem.warningForeground")
      : undefined;
    mainStatusBar.tooltip = needToken
      ? vscode.l10n.t("Click to set Session Token")
      : err
        ? `${err}\n${vscode.l10n.t("Click to view details")}`
        : vscode.l10n.t("Loading...");
    return;
  }

  const config = vscode.workspace.getConfiguration("cursorTokenUsage");
  const dataSource = config.get<string>("statusBarDataSource", "current");
  const combined = tracker.getCombinedView();
  const useOverview = dataSource === "overview" && combined;

  if (useOverview && combined) {
    const body = formatOverviewStatusBar(combined);
    mainStatusBar.text = `$(graph) ${body}`;
    mainStatusBar.tooltip = buildOverviewTooltip(combined, tracker.lastSuccessTime);
    applyStatusBarColors(mainStatusBar, tracker.lastSnapshot ?? snapshot, config, combined);
    return;
  }

  // Icon conveys usage entry; body is self-descriptive
  const body = formatStatusBar(snapshot);
  mainStatusBar.text = `$(graph) ${body}`;
  mainStatusBar.tooltip = buildTooltipLines(snapshot, {
    viewScope: tracker.viewScope,
    accountCount: listAccountSnapshots().length,
    lastSuccess: tracker.lastSuccessTime,
  });
  applyStatusBarColors(mainStatusBar, snapshot);
}

function isTokenError(err: string | null): boolean {
  return !!err && /session token/i.test(err);
}

function showDetails(): void {
  if (!tracker.lastSnapshot && isTokenError(tracker.lastError)) {
    void setToken();
    return;
  }
  const existing = !!UsagePanel.current;
  UsagePanel.show(
    extensionContext,
    () => tracker.getPanelContext(),
    () => tracker.lastError,
    (command, payload) => {
      if (command === "refresh") void refresh();
      if (command === "token") void setToken();
      if (command === "align") void setStatusBarAlignment();
      if (command === "alerts") void configureAlerts();
      if (command === "switchView") void switchAccountView();
      if (command === "export") void exportUsage();
      if (command === "drillAccount" && payload?.userId) {
        tracker.setViewScope("account", payload.userId);
        UsagePanel.current?.refresh();
        updateStatusBar();
      }
      if (command === "backOverview") {
        tracker.setViewScope("all");
        UsagePanel.current?.refresh();
        updateStatusBar();
      }
    },
  );
  const ageMs = tracker.lastSuccessTime ? Date.now() - tracker.lastSuccessTime.getTime() : Infinity;
  if (!existing || ageMs > 60_000) void refresh();
}

async function setToken(): Promise<void> {
  const token = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Enter Cursor Session Token (format: userId%3A%3AaccessToken)"),
    placeHolder: "userId%3A%3AaccessToken",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v) return null;
      if (!v.includes("%3A%3A")) return vscode.l10n.t("Invalid format (expected userId%3A%3AaccessToken)");
      return null;
    },
  });
  if (token === undefined) return;
  if (token) await storeSecretToken(token);
  else await deleteSecretToken();
  vscode.window.showInformationMessage(token ? vscode.l10n.t("Token saved") : vscode.l10n.t("Token cleared"));
  await refresh();
}

async function setPollingInterval(): Promise<void> {
  const config = vscode.workspace.getConfiguration("cursorTokenUsage");
  const input = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Set polling interval in seconds (5-300)"),
    value: String(config.get("pollingInterval", 30)),
    validateInput: (v) => {
      const n = parseInt(v, 10);
      return Number.isNaN(n) || n < 5 || n > 300
        ? vscode.l10n.t("Please enter a number between 5 and 300")
        : null;
    },
  });
  if (input !== undefined) {
    await config.update("pollingInterval", parseInt(input, 10), vscode.ConfigurationTarget.Global);
  }
}

async function setStatusBarAlignment(): Promise<void> {
  const config = vscode.workspace.getConfiguration("cursorTokenUsage");
  const current = config.get<string>("statusBarAlignment", "right");
  const pick = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("Left"), description: current === "left" ? "✓" : "", id: "left" },
      { label: vscode.l10n.t("Right"), description: current === "right" ? "✓" : "", id: "right" },
    ],
    { placeHolder: vscode.l10n.t("Status bar side") },
  );
  if (!pick) return;
  await config.update("statusBarAlignment", pick.id, vscode.ConfigurationTarget.Global);
}

async function configureAlerts(): Promise<void> {
  const config = vscode.workspace.getConfiguration("cursorTokenUsage");
  const action = await vscode.window.showQuickPick(
    [
      {
        label: config.get("alertEnabled", true)
          ? vscode.l10n.t("Disable alerts")
          : vscode.l10n.t("Enable alerts"),
        id: "toggle",
      },
      { label: vscode.l10n.t("Select monitoring items"), id: "items" },
      { label: vscode.l10n.t("Set thresholds"), id: "thresholds" },
    ],
    { placeHolder: vscode.l10n.t("Configure usage alerts") },
  );
  if (!action) return;
  if (action.id === "toggle") {
    const next = !config.get("alertEnabled", true);
    await config.update("alertEnabled", next, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(next ? vscode.l10n.t("Alerts enabled") : vscode.l10n.t("Alerts disabled"));
    return;
  }
  if (action.id === "items") {
    const current = new Set(config.get<string[]>("alertItems", []));
    const picks = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t("New usage requests"), id: "newSession" },
        { label: vscode.l10n.t("Included usage change"), id: "overallSpending" },
        { label: vscode.l10n.t("Cursor Models %"), id: "cursorModels" },
        { label: vscode.l10n.t("Other Models %"), id: "otherModels" },
        { label: vscode.l10n.t("On-Demand spending change"), id: "onDemandSpending" },
        { label: vscode.l10n.t("Total Token consumption change"), id: "totalTokens" },
      ].map((p) => ({ ...p, picked: current.has(p.id) })),
      { canPickMany: true, placeHolder: vscode.l10n.t("Select items to monitor") },
    );
    if (picks) {
      await config.update("alertItems", picks.map((p) => p.id), vscode.ConfigurationTarget.Global);
    }
    return;
  }
  const keys = [
    { id: "newSession", label: vscode.l10n.t("New usage requests") },
    { id: "overallSpending", label: vscode.l10n.t("Included usage change") },
    { id: "cursorModels", label: vscode.l10n.t("Cursor Models %") },
    { id: "otherModels", label: vscode.l10n.t("Other Models %") },
    { id: "onDemandSpending", label: vscode.l10n.t("On-Demand spending change") },
    { id: "totalTokens", label: vscode.l10n.t("Total Token consumption change") },
  ];
  const pick = await vscode.window.showQuickPick(keys, { placeHolder: vscode.l10n.t("Select threshold to configure") });
  if (!pick) return;
  const current = config.get<number>(`alertThreshold.${pick.id}`, 0);
  const input = await vscode.window.showInputBox({
    prompt: `${pick.label} ${vscode.l10n.t("threshold")}`,
    value: String(current),
    validateInput: (v) =>
      Number.isNaN(Number(v)) || Number(v) < 0
        ? vscode.l10n.t("Please enter a number between {0} and {1}", 0, 1e12)
        : null,
  });
  if (input !== undefined) {
    await config.update(`alertThreshold.${pick.id}`, Number(input), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(vscode.l10n.t("Threshold updated: {0} = {1}", pick.label, input));
  }
}

async function diagnoseAuth(): Promise<void> {
  const manual = await getSecretToken();
  const lines = await runDiagnoseAuth(manual);
  const ch = vscode.window.createOutputChannel("Cursor Token Usage - Diagnose");
  ch.clear();
  ch.appendLine("=== Cursor Token Usage: Diagnose Auth ===");
  for (const line of lines) ch.appendLine(line);
  ch.show(true);
}

async function switchAccountView(): Promise<void> {
  const current = tracker.lastSnapshot;
  const accounts = listAccountSnapshots();
  const picks = [
    {
      label: vscode.l10n.t("Overview (all accounts)"),
      description: `${accounts.length} ${vscode.l10n.t("accounts")}`,
      id: "all",
    },
    {
      label: vscode.l10n.t("Current account"),
      description: current?.accountLabel ?? current?.userId?.slice(0, 8) ?? "",
      id: "current",
    },
    ...accounts
      .filter((a) => a.userId !== current?.userId)
      .map((a) => ({
        label: a.accountLabel ?? `${a.userId.slice(0, 8)}…`,
        description: a.membershipType,
        id: `account:${a.userId}`,
      })),
  ];
  const pick = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t("Switch account view") });
  if (!pick) return;
  if (pick.id === "current") {
    tracker.setViewScope("current");
  } else if (pick.id === "all") {
    tracker.setViewScope("all");
  } else if (pick.id.startsWith("account:")) {
    tracker.setViewScope("account", pick.id.slice("account:".length));
  }
  UsagePanel.current?.refresh();
  updateStatusBar();
}

async function exportUsage(): Promise<void> {
  const data = tracker.getPanelData();
  if (!data) {
    vscode.window.showWarningMessage(vscode.l10n.t("No usage data to export"));
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    filters: { JSON: ["json"], CSV: ["csv"] },
    defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", "cursor-usage-export.json")),
  });
  if (!uri) return;
  const ext = path.extname(uri.fsPath).toLowerCase();
  if (ext === ".csv") {
    fs.writeFileSync(uri.fsPath, buildCsv(data), "utf8");
  } else {
    fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), "utf8");
  }
  vscode.window.showInformationMessage(vscode.l10n.t("Exported to {0}", uri.fsPath));
}

function buildCsv(data: UsageSnapshot | CombinedViewDto): string {
  if (isCombinedView(data)) {
    const header = "label,userId,membership,totalTokens,cacheHitRate,cacheRead,cacheWrite,input,output,overallUsedCents,overallLimitCents,updatedAt\n";
    const rows = data.perAccountRows
      .map((r) =>
        [
          csvEscape(r.label),
          r.userId,
          r.membershipType,
          r.totalTokens,
          r.cacheHitRate !== null ? (r.cacheHitRate * 100).toFixed(1) : "",
          r.cacheReadTokens,
          r.cacheWriteTokens,
          "",
          "",
          r.overallUsedCents ?? "",
          r.overallLimitCents ?? "",
          r.updatedAt,
        ].join(","),
      )
      .join("\n");
    return header + rows;
  }
  return `label,userId,membership,totalTokens,cursorModelsPercent,otherModelsPercent\n${csvEscape(data.accountLabel ?? "")},${data.userId},${data.membershipType},${data.totalTokens},${data.cursorModelsPercent ?? ""},${data.otherModelsPercent ?? ""}\n`;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"')) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function showAlerts(alerts: UsageAlert[]): void {
  const messages = alerts.map((alert) => {
    switch (alert.type) {
      case "newSession":
        return vscode.l10n.t("Detected {0} new usage request(s)", alert.delta);
      case "cursorModels":
        return vscode.l10n.t("Cursor Models usage increased by {0}%", Math.round(alert.delta));
      case "otherModels":
        return vscode.l10n.t("Other Models usage increased by {0}%", Math.round(alert.delta));
      case "overallSpending":
        return vscode.l10n.t("Included usage increased by ${0}", alert.delta.toFixed(2));
      case "onDemandSpending":
        return vscode.l10n.t("On-Demand spending increased by ${0}", alert.delta.toFixed(2));
      case "totalTokens":
        return vscode.l10n.t("Token consumption increased by {0}", formatTokens(alert.delta));
      default:
        return "";
    }
  });
  vscode.window.showWarningMessage(`${vscode.l10n.t("Cursor Usage Alert")}: ${messages.join(" · ")}`);
}
