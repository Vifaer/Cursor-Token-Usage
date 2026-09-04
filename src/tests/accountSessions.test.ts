import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isJwtExpired, parseSessionCookie } from "../jwtSession";

function fakeJwt(sub: string, expOffsetSec = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

describe("accountSessions pure rules", () => {
  it("normalizes cookie to JWT sub so same token cannot be two accounts", () => {
    const jwt = fakeJwt("auth0|user_01CCCCCCCCCCCCCCCCCCCCCC");
    const a = parseSessionCookie(`user_WRONGWRONGWRONGWRONGWRON%3A%3A${jwt}`);
    const b = parseSessionCookie(`user_01CCCCCCCCCCCCCCCCCCCCCC%3A%3A${jwt}`);
    assert.ok(a && b);
    assert.equal(a!.userId, b!.userId);
    assert.equal(a!.cookieValue, b!.cookieValue);
  });

  it("skips expired JWT for retention", () => {
    const expired = fakeJwt("auth0|user_01DDDDDDDDDDDDDDDDDDDDDD", -10);
    assert.equal(isJwtExpired(expired), true);
    const live = fakeJwt("auth0|user_01EEEEEEEEEEEEEEEEEEEEEE");
    assert.equal(isJwtExpired(live), false);
  });
});
