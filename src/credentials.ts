import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";

const log = vscode.window.createOutputChannel("Cursor Token Usage - Credentials");
const MAX_JSON_FILE_SIZE = 10 * 1024 * 1024;

let cachedAccessToken: string | null = null;
let cachedUserId: string | null = null;

export function clearCachedToken(): void {
  cachedAccessToken = null;
  cachedUserId = null;
}

export function getDbPath(): string {
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

export async function getUserId(): Promise<string | null> {
  if (cachedUserId) return cachedUserId;
  for (const p of getStoragePaths()) {
    try {
      const userId = await findUserIdInFile(p);
      if (userId) {
        cachedUserId = userId;
        return userId;
      }
    } catch (err) {
      log.appendLine(`读取 ${p} 失败: ${err}`);
    }
  }
  const dbPath = getDbPath();
  if (fs.existsSync(dbPath)) {
    const raw = await queryDb(dbPath, "cursorAuth/cachedSignUpId");
    const userId = raw ? extractUserId(raw) : null;
    if (userId) {
      cachedUserId = userId;
      return userId;
    }
  }
  return null;
}

export async function getAccessToken(): Promise<string | null> {
  if (cachedAccessToken) return cachedAccessToken;
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    log.appendLine(`数据库不存在: ${dbPath}`);
    return null;
  }
  const token = await queryDb(dbPath, "cursorAuth/accessToken");
  if (token) {
    cachedAccessToken = token;
    return token;
  }
  return null;
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

async function queryDb(dbPath: string, key: string): Promise<string | null> {
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
  log.appendLine(`无法查询数据库 key=${key}`);
  return null;
}

function execFileAsync(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}
