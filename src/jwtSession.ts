import { SessionInfo } from "./models";

const USER_ID_RE = /^user_[a-zA-Z0-9]{20,}$/;

export function extractUserId(oauthId: string): string | null {
  if (!oauthId) return null;
  if (oauthId.includes("|")) {
    const part = oauthId.split("|").find((p) => p.startsWith("user_"));
    if (part) return part;
  }
  return oauthId.startsWith("user_") ? oauthId : null;
}

/** WorkOS user id from JWT `sub` (community standard for WorkosCursorSessionToken). */
export function userIdFromJwt(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { sub?: unknown };
    if (typeof claims.sub !== "string") return null;
    const uid = extractUserId(claims.sub);
    return uid && USER_ID_RE.test(uid) ? uid : null;
  } catch {
    return null;
  }
}

/** JWT `exp` in epoch ms, or null if missing/invalid. */
export function jwtExpMs(accessToken: string): number | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { exp?: unknown };
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
    return claims.exp * 1000;
  } catch {
    return null;
  }
}

/** Parse cookie; prefer JWT sub over the prefix so mislabeled prefixes cannot stick. */
export function parseSessionCookie(cookieValue: string): SessionInfo | null {
  if (!cookieValue.includes("%3A%3A")) return null;
  const idx = cookieValue.indexOf("%3A%3A");
  const prefix = cookieValue.slice(0, idx);
  const accessToken = cookieValue.slice(idx + "%3A%3A".length);
  if (!accessToken) return null;
  const fromJwt = userIdFromJwt(accessToken);
  const fromPrefix = USER_ID_RE.test(prefix) ? prefix : extractUserId(prefix);
  const userId = fromJwt ?? fromPrefix;
  if (!userId || !USER_ID_RE.test(userId)) return null;
  return { userId, accessToken, cookieValue: `${userId}%3A%3A${accessToken}` };
}

export function isJwtExpired(accessToken: string, now = Date.now()): boolean {
  const exp = jwtExpMs(accessToken);
  if (exp == null) return false;
  return exp <= now;
}
