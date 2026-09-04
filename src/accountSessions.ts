import * as vscode from "vscode";
import { isJwtExpired, parseSessionCookie } from "./jwtSession";
import { SessionInfo } from "./models";

const SESSIONS_KEY = "cursorTokenUsage.accountSessions.v1";
export const MAX_STORED_SESSION_POLLS = 5;

export interface StoredAccountSession {
  cookie: string;
  email?: string;
  updatedAt: string;
}

type SessionMap = Record<string, StoredAccountSession>;

let secrets: vscode.SecretStorage | null = null;

export function initAccountSessions(storage: vscode.SecretStorage): void {
  secrets = storage;
}

async function readMap(): Promise<SessionMap> {
  const raw = await secrets?.get(SESSIONS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as SessionMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMap(map: SessionMap): Promise<void> {
  await secrets?.store(SESSIONS_KEY, JSON.stringify(map));
}

/** Upsert by JWT.sub (normalized cookie). Same JWT replaces prior row. */
export async function upsertAccountSession(
  cookieValue: string,
  email?: string,
): Promise<SessionInfo | null> {
  const session = parseSessionCookie(cookieValue);
  if (!session) return null;
  if (isJwtExpired(session.accessToken)) return null;
  const map = await readMap();
  for (const [uid, row] of Object.entries(map)) {
    const parsed = parseSessionCookie(row.cookie);
    if (parsed && parsed.accessToken === session.accessToken && uid !== session.userId) {
      delete map[uid];
    }
  }
  const prev = map[session.userId];
  map[session.userId] = {
    cookie: session.cookieValue,
    email: email?.trim() || prev?.email,
    updatedAt: new Date().toISOString(),
  };
  await writeMap(map);
  return session;
}

export async function dropAccountSession(userId: string): Promise<void> {
  const map = await readMap();
  if (!map[userId]) return;
  delete map[userId];
  await writeMap(map);
}

export async function clearAccountSessions(): Promise<void> {
  await secrets?.delete(SESSIONS_KEY);
}

/**
 * List stored sessions excluding the current JWT (same accessToken = not a second account).
 * Skips expired JWTs and prunes them from storage.
 */
export async function listAccountSessions(opts?: {
  excludeAccessToken?: string;
  excludeUserId?: string;
  limit?: number;
}): Promise<Array<SessionInfo & { email?: string }>> {
  const map = await readMap();
  const limit = opts?.limit ?? MAX_STORED_SESSION_POLLS;
  const out: Array<SessionInfo & { email?: string }> = [];
  let dirty = false;

  const entries = Object.entries(map).sort(
    (a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt),
  );

  for (const [uid, row] of entries) {
    const session = parseSessionCookie(row.cookie);
    if (!session) {
      delete map[uid];
      dirty = true;
      continue;
    }
    if (isJwtExpired(session.accessToken)) {
      delete map[uid];
      dirty = true;
      continue;
    }
    if (opts?.excludeAccessToken && session.accessToken === opts.excludeAccessToken) {
      continue;
    }
    if (opts?.excludeUserId && session.userId === opts.excludeUserId) {
      continue;
    }
    if (uid !== session.userId) {
      delete map[uid];
      map[session.userId] = { ...row, cookie: session.cookieValue };
      dirty = true;
    }
    out.push({ ...session, email: row.email });
    if (out.length >= limit) break;
  }

  if (dirty) await writeMap(map);
  return out;
}
