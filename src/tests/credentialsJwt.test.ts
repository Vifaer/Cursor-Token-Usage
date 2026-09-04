import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isJwtExpired, jwtExpMs, parseSessionCookie, userIdFromJwt } from "../jwtSession";

function fakeJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

describe("userIdFromJwt", () => {
  it("strips auth0| prefix from sub", () => {
    const tok = fakeJwt({ sub: "auth0|user_01ABCDEFGHIJKLMNOPQRSTUV" });
    assert.equal(userIdFromJwt(tok), "user_01ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("accepts bare user_ sub", () => {
    const tok = fakeJwt({ sub: "user_01ABCDEFGHIJKLMNOPQRSTUV" });
    assert.equal(userIdFromJwt(tok), "user_01ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("rejects missing sub", () => {
    assert.equal(userIdFromJwt(fakeJwt({ aud: "x" })), null);
  });
});

describe("parseSessionCookie", () => {
  it("prefers JWT sub over mismatched cookie prefix", () => {
    const jwtUid = "user_01JWTJWTJWTJWTJWTJWTJWTJWT";
    const tok = fakeJwt({ sub: `auth0|${jwtUid}` });
    const cookie = `user_01PREFIXPREFIXPREFIXPREFIX%3A%3A${tok}`;
    const parsed = parseSessionCookie(cookie);
    assert.ok(parsed);
    assert.equal(parsed!.userId, jwtUid);
    assert.equal(parsed!.cookieValue, `${jwtUid}%3A%3A${tok}`);
  });
});

describe("jwtExpMs / isJwtExpired", () => {
  it("reads exp claim", () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const tok = fakeJwt({ sub: "auth0|user_01ABCDEFGHIJKLMNOPQRSTUV", exp: expSec });
    assert.equal(jwtExpMs(tok), expSec * 1000);
    assert.equal(isJwtExpired(tok), false);
  });

  it("flags expired tokens", () => {
    const tok = fakeJwt({ sub: "auth0|user_01ABCDEFGHIJKLMNOPQRSTUV", exp: 1 });
    assert.equal(isJwtExpired(tok), true);
  });
});
