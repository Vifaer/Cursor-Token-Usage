/**
 * Cursor Token Usage — status-bar usage for Cursor token billing.
 * Individual accounts: two pool percentages. Team/Enterprise: included spend vs limit.
 */
import * as vscode from "vscode";
import {
  deleteSecretToken,
  initSecretStorage,
  storeSecretToken,
} from "./api";
import { UsageAlert, UsageSnapshot } from "./models";
import { UsagePanel } from "./panel";
import { UsageTracker } from "./tracker";
import { formatPct, formatTokens, membershipLabel } from "./treeView";

let pollTimer: NodeJS.Timeout | undefined;
let tracker: UsageTracker;
let mainStatusBar: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let windowFocused = true;
let suppressStale = false;

const STATUS_ICON = "$(graph)";

export function activate(context: vscode.ExtensionContext): void {
  initSecretStorage(context.secrets);
  extensionContext = context;
  tracker = new UsageTracker();

  recreateStatusBar();

  tracker.onUpdate = () => {
    updateStatusBar();
    if (!suppressStale && !tracker.lastError) UsagePanel.current?.markStale();
  };
  tracker.onAlert = (alerts) => showAlerts(alerts);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursor-token-usage.showDetails", showDetails),
    vscode.commands.registerCommand("cursor-token-usage.refresh", refresh),
    vscode.commands.registerCommand("cursor-token-usage.setToken", setToken),
    vscode.commands.registerCommand("cursor-token-usage.setPollingInterval", setPollingInterval),
    vscode.commands.registerCommand("cursor-token-usage.setStatusBarAlignment", setStatusBarAlignment),
    vscode.commands.registerCommand("cursor-token-usage.configureAlerts", configureAlerts),
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
  mainStatusBar.text = `${STATUS_ICON} …`;
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
  mainStatusBar = vscode.window.createStatusBarItem(alignment, 100);
  mainStatusBar.command = "cursor-token-usage.showDetails";
  mainStatusBar.text = `${STATUS_ICON} Token …`;
  mainStatusBar.tooltip = vscode.l10n.t("Click to view details");
  mainStatusBar.show();
  extensionContext.subscriptions.push(mainStatusBar);
  updateStatusBar();
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function usageRatio(snapshot: UsageSnapshot): number | null {
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents && snapshot.overallLimitCents > 0) {
    return snapshot.overallUsedCents / snapshot.overallLimitCents;
  }
  if (snapshot.cursorModelsPercent === null && snapshot.otherModelsPercent === null) return null;
  return Math.max(snapshot.cursorModelsPercent ?? 0, snapshot.otherModelsPercent ?? 0) / 100;
}

function updateStatusBar(): void {
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
      ? `$(key) ${vscode.l10n.t("Set Token")}`
      : err
        ? `$(warning) ${vscode.l10n.t("Token ?")}`
        : `${STATUS_ICON} ${vscode.l10n.t("Loading...")}`;
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

  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents !== null) {
    mainStatusBar.text = `${STATUS_ICON} ${formatCents(snapshot.overallUsedCents)}/${formatCents(snapshot.overallLimitCents)}`;
  } else {
    const c = formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited);
    const o = formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited);
    mainStatusBar.text = `${STATUS_ICON} C ${c} · O ${o}`;
  }
  mainStatusBar.tooltip = buildTooltip(snapshot);
  const ratio = usageRatio(snapshot);
  if (!snapshot.isUnlimited && ratio !== null && ratio >= 1) {
    mainStatusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    mainStatusBar.color = new vscode.ThemeColor("statusBarItem.errorForeground");
  } else if (!snapshot.isUnlimited && ratio !== null && ratio >= 0.8) {
    mainStatusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    mainStatusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
  } else {
    mainStatusBar.backgroundColor = undefined;
    mainStatusBar.color = undefined;
  }
}

function buildTooltip(snapshot: UsageSnapshot): string {
  const lines = [
    `Cursor Token Usage · ${membershipLabel(snapshot.membershipType)}`,
    snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents !== null
      ? `${vscode.l10n.t("Included usage")}: ${formatCents(snapshot.overallUsedCents)}/${formatCents(snapshot.overallLimitCents)}`
      : "",
    snapshot.cursorModelsPercent !== null ? `Cursor Models: ${formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited)}` : "",
    snapshot.otherModelsPercent !== null ? `Other Models: ${formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited)}` : "",
    countdownLine(snapshot.billingCycleEnd),
    snapshot.onDemandEnabled && snapshot.onDemandUsedCents !== null
      ? `On-Demand: ${formatCents(snapshot.onDemandUsedCents)}${
          snapshot.onDemandLimitCents && snapshot.onDemandLimitCents > 0
            ? `/${formatCents(snapshot.onDemandLimitCents)}`
            : ""
        }`
      : "",
    `${vscode.l10n.t("Total Tokens")}: ${formatTokens(snapshot.totalTokens)}`,
    vscode.l10n.t("Click to view details"),
  ];
  return lines.filter((line) => line).join("\n");
}

function countdownLine(endIso: string): string {
  if (!endIso) return "";
  const msLeft = Math.max(0, Date.parse(endIso) - Date.now());
  const totalSeconds = Math.ceil(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  let countdown: string;
  if (days > 0) countdown = vscode.l10n.t("{0}d {1}h", days, hours);
  else if (hours > 0) countdown = vscode.l10n.t("{0}h {1}m", hours, minutes);
  else countdown = vscode.l10n.t("{0}m {1}s", minutes, totalSeconds % 60);
  return vscode.l10n.t("Reset in: {0}", countdown);
}

function isTokenError(err: string | null): boolean {
  return !!err && /session token/i.test(err);
}

function showDetails(): void {
  if (!tracker.lastSnapshot && isTokenError(tracker.lastError)) {
    void setToken();
    return;
  }
  UsagePanel.show(
    extensionContext,
    () => tracker.lastSnapshot,
    () => tracker.lastError,
    (command) => {
      if (command === "refresh") void refresh();
      if (command === "token") void setToken();
      if (command === "align") void setStatusBarAlignment();
      if (command === "alerts") void configureAlerts();
    },
  );
  void refresh();
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
