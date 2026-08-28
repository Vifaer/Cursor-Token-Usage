import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { AccountIdentity, SessionInfo } from "./models";

type SqlJsInit = (config?: { locateFile?: (file: string) => string }) => Promise<{
  Database: new (data?: ArrayLike<number> | Buffer | null) => {
    prepare(sql: string): {
      bind(params: unknown[]): void;
      step(): boolean;
      getAsObject(): Record<string, unknown>;
      free?: () => void;
    };
    close(): void;
  };
}>;

const log = vscode.window.createOutputChannel("Cursor Token Usage - Credentials");
const MAX_JSON_FILE_SIZE = 10 * 1024 * 1024;
const LARGE_DB_BYTES = 2 * 1024 * 1024 * 1024;
const PYTHON_FIRST_BYTES = 10 * 1024 * 1024;
const USER_ID_TTL_MS = 60_000;
const PYTHON_TIMEOUT_MS = 8_000;

let lastSession: SessionInfo | null = null;
let lastSessionUserId: string | null = null;
let lastUserIdCheckAt = 0;
let sqlJsPromise: ReturnType<SqlJsInit> | null = null;
let extensionPath = "";

export function setExtensionPath(p: string): void {
  extensionPath = p;
}

export function clearCachedToken(): void {
  lastSession = null;
  lastSessionUserId = null;
  lastUserIdCheckAt = 0;
}

export function invalidateSession(): void {
  clearCachedToken();
}

export function getDbPath(): string {
  const custom = vscode.workspace.getConfiguration("cursorTokenUsage").get<string>("stateDbPath", "");
  if (custom?.trim()) return path.resolve(custom.trim());
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function loadSqlJs(): SqlJsInit | null {
  try {
    // Lazy require so missing sql.js never blocks extension activation
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("sql.js") as SqlJsInit | { default: SqlJsInit };
    return typeof mod === "function" ? mod : mod.default;
  } catch (err) {
    log.appendLine(`sql.js module unavailable: ${err}`);
    return null;
  }
}

async function getSqlJs() {
  if (!sqlJsPromise) {
    const initSqlJs = loadSqlJs();
    if (!initSqlJs) return null;
    const wasmPath = path.join(extensionPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
    sqlJsPromise = initSqlJs({
      locateFile: () => wasmPath,
    });
  }
  return sqlJsPromise;
}

async function queryDbSqlJs(dbPath: string, key: string): Promise<string | null> {
  try {
    const stat = fs.statSync(dbPath);
    if (stat.size >= LARGE_DB_BYTES) return null;
    const SQL = await getSqlJs();
    if (!SQL) return null;
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    let stmt: { bind(params: unknown[]): void; step(): boolean; getAsObject(): Record<string, unknown>; free?: () => void } | null = null;
    try {
      stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1");
      stmt.bind([key]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as { value?: string };
        return row.value ? String(row.value) : null;
      }
    } finally {
      try {
        stmt?.free?.();
      } catch {
        /* ignore */
      }
      db.close();
    }
  } catch (err) {
    log.appendLine(`sql.js read failed: ${err}`);
  }
  return null;
}

async function queryDbPython(dbPath: string, key: string): Promise<string | null> {
  const cmds = process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  const script =
    "import sqlite3, sys, pathlib; p = pathlib.Path(sys.argv[1]).expanduser().resolve(); " +
    "conn = None\n" +
    "try:\n" +
    "    conn = sqlite3.connect(p.as_uri() + '?mode=ro', uri=True)\n" +
    "except Exception:\n" +
    "    conn = sqlite3.connect(str(p))\n" +
    "cur = conn.cursor(); " +
    "cur.execute('SELECT value FROM ItemTable WHERE key = ? LIMIT 1', (sys.argv[2],)); " +
    "row = cur.fetchone(); print(row[0] if row and row[0] else ''); conn.close()";
  for (const cmd of cmds) {
    try {
      const value = await execFileAsync(cmd, ["-c", script, dbPath, key]);
      if (value) return value;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function queryDb(dbPath: string, key: string): Promise<string | null> {
  let size = 0;
  try {
    size = fs.statSync(dbPath).size;
  } catch {
    return null;
  }
  if (size >= PYTHON_FIRST_BYTES) {
    const py = await queryDbPython(dbPath, key);
    if (py) return py;
    return queryDbSqlJs(dbPath, key);
  }
  const sqlValue = await queryDbSqlJs(dbPath, key);
  if (sqlValue) return sqlValue;
  return queryDbPython(dbPath, key);
}

function getStoragePaths(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const base =
    process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Cursor")
        : path.join(home, ".config", "Cursor");
  return [
    path.join(base, "sentry", "scope_v3.json"),
    path.join(base, "sentry", "session.json"),
    path.join(base, "User", "globalStorage", "storage.json"),
  ];
}

async function findUserIdInFile(filePath: string): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_JSON_FILE_SIZE) return null;
  const content = fs.readFileSync(filePath, "utf8");
  try {
    const data = JSON.parse(content);
    if (data.scope?.user?.id) {
      const uid = extractUserId(data.scope.user.id);
      if (uid) return uid;
    }
    if (data.did) {
      const uid = extractUserId(data.did);
      if (uid) return uid;
    }
  } catch {
    /* fall through */
  }
  const match = content.match(/user_[a-zA-Z0-9]{20,}/);
  return match ? extractUserId(match[0]) : null;
}

function extractUserId(oauthId: string): string | null {
  if (!oauthId) return null;
  if (oauthId.includes("|")) {
    const part = oauthId.split("|").find((p) => p.startsWith("user_"));
    if (part) return part;
  }
  return oauthId.startsWith("user_") ? oauthId : null;
}

function extractEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v.includes("@") ? v : undefined;
}

function extractDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.startsWith("user_")) return undefined;
  return v;
}

async function readIdentityFromFiles(): Promise<Partial<AccountIdentity>> {
  const out: Partial<AccountIdentity> = {};
  for (const p of getStoragePaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const stat = fs.statSync(p);
      if (stat.size > MAX_JSON_FILE_SIZE) continue;
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const user = data.scope?.user ?? data.user;
      if (user) {
        out.email = out.email ?? extractEmail(user.email);
        out.displayName = out.displayName ?? extractDisplayName(user.username) ?? extractDisplayName(user.name);
        out.userId = out.userId ?? extractUserId(user.id) ?? undefined;
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function readFreshUserId(): Promise<string | null> {
  for (const p of getStoragePaths()) {
    try {
      const userId = await findUserIdInFile(p);
      if (userId) return userId;
    } catch (err) {
      log.appendLine(`read ${p} failed: ${err}`);
    }
  }
  const dbPath = getDbPath();
  if (fs.existsSync(dbPath)) {
    const raw = await queryDb(dbPath, "cursorAuth/cachedSignUpId");
    const userId = raw ? extractUserId(raw) : null;
    if (userId) return userId;
  }
  return null;
}

async function readFreshAccessToken(): Promise<string | null> {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    log.appendLine(`DB missing: ${dbPath}`);
    return null;
  }
  return queryDb(dbPath, "cursorAuth/accessToken");
}

/** Resolve human-readable identity: email > displayName. */
export async function readAccountIdentity(): Promise<AccountIdentity | null> {
  const fromFiles = await readIdentityFromFiles();
  const dbPath = getDbPath();
  let email = fromFiles.email;
  let displayName = fromFiles.displayName;
  let userId = fromFiles.userId ?? null;

  if (fs.existsSync(dbPath)) {
    if (!email) email = extractEmail(await queryDb(dbPath, "cursorAuth/cachedEmail"));
    if (!userId) {
      const raw = await queryDb(dbPath, "cursorAuth/cachedSignUpId");
      userId = raw ? extractUserId(raw) : null;
    }
  }
  if (!userId) userId = await readFreshUserId();
  if (!userId) return null;
  return { userId, email, displayName };
}

/**
 * Hot path: return cached session within USER_ID_TTL_MS without touching DB.
 * Cold path: re-read userId; only re-read accessToken when userId changes.
 */
export async function getSession(manualToken?: string): Promise<SessionInfo | null> {
  if (manualToken) {
    const manualUserId = manualToken.split("%3A%3A")[0];
    if (!/^user_[a-zA-Z0-9]{20,}$/.test(manualUserId)) return null;
    return { userId: manualUserId, accessToken: manualToken.split("%3A%3A")[1] ?? "", cookieValue: manualToken };
  }

  const now = Date.now();
  if (lastSession && lastSessionUserId && now - lastUserIdCheckAt < USER_ID_TTL_MS) {
    return lastSession;
  }

  const userId = await readFreshUserId();
  if (!userId) {
    clearCachedToken();
    return null;
  }

  if (lastSession && lastSessionUserId === userId) {
    lastUserIdCheckAt = now;
    return lastSession;
  }

  clearCachedToken();
  const accessToken = await readFreshAccessToken();
  if (!accessToken) return null;

  const cookieValue = `${userId}%3A%3A${accessToken}`;
  lastSession = { userId, accessToken, cookieValue };
  lastSessionUserId = userId;
  lastUserIdCheckAt = now;
  return lastSession;
}

export async function runDiagnoseAuth(manualToken?: string): Promise<string[]> {
  const lines: string[] = [];
  const dbPath = getDbPath();
  lines.push(`DB path: ${dbPath}`);
  lines.push(`DB exists: ${fs.existsSync(dbPath)}`);
  let size = 0;
  if (fs.existsSync(dbPath)) {
    try {
      const stat = fs.statSync(dbPath);
      size = stat.size;
      lines.push(`DB size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
      lines.push(`mtime: ${stat.mtime.toISOString()}`);
      lines.push(`Prefer Python (>=10MB): ${stat.size >= PYTHON_FIRST_BYTES}`);
    } catch (err) {
      lines.push(`DB stat error: ${err}`);
    }
  }

  for (const p of getStoragePaths()) {
    lines.push(`UserId file ${p}: ${fs.existsSync(p) ? "found" : "missing"}`);
  }

  const identity = await readAccountIdentity();
  lines.push(`UserId: ${identity?.userId ?? "(none)"}`);
  lines.push(`Email: ${identity?.email ?? "(none)"}`);
  lines.push(`DisplayName: ${identity?.displayName ?? "(none)"}`);

  if (manualToken) {
    lines.push(`Access token: manual`);
  } else if (fs.existsSync(dbPath)) {
    let method = "(none)";
    if (size >= PYTHON_FIRST_BYTES) {
      if (await queryDbPython(dbPath, "cursorAuth/accessToken")) method = "python";
      else if (await queryDbSqlJs(dbPath, "cursorAuth/accessToken")) method = "sql.js";
    } else {
      if (await queryDbSqlJs(dbPath, "cursorAuth/accessToken")) method = "sql.js";
      else if (await queryDbPython(dbPath, "cursorAuth/accessToken")) method = "python";
    }
    lines.push(`Access token method: ${method}`);
  }

  const cmds = process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  const pythonFound = cmds.find((c) => {
    try {
      require("child_process").execFileSync(c, ["--version"], { stdio: "ignore", windowsHide: true });
      return true;
    } catch {
      return false;
    }
  });
  lines.push(`Python fallback: ${pythonFound ?? "(none)"}`);
  lines.push(`Extension path: ${extensionPath || "(unset)"}`);
  lines.push(`Session cache TTL: ${USER_ID_TTL_MS}ms`);
  return lines;
}

function execFileAsync(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, timeout: PYTHON_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

export async function getUserId(): Promise<string | null> {
  const s = await getSession();
  return s?.userId ?? null;
}

export async function getAccessToken(): Promise<string | null> {
  const s = await getSession();
  return s?.accessToken ?? null;
}
