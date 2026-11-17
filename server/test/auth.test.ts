import { describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { buildApp } from "../src/app.js";
import "../src/routes/all.js";
import { authToken, checkPassword, cookieValue, isAuthorized } from "../src/util/auth.js";

describe("auth helpers", () => {
  it("token is derived (not the password), compared in constant time, and cookies parse", () => {
    expect(authToken("pw")).not.toContain("pw"); expect(authToken("pw")).toBe(authToken("pw")); expect(authToken("pw")).not.toBe(authToken("pw2"));
    expect(cookieValue("a=1; om_auth=abc; b=2", "om_auth")).toBe("abc"); expect(cookieValue("a=1", "om_auth")).toBeUndefined();
    expect(isAuthorized("", {})).toBe(true); expect(isAuthorized("pw", {})).toBe(false);
    expect(isAuthorized("pw", { authorization: "Bearer pw" })).toBe(true); expect(isAuthorized("pw", { authorization: "Bearer nope" })).toBe(false);
    expect(isAuthorized("pw", { cookie: `om_auth=${authToken("pw")}` })).toBe(true); expect(isAuthorized("pw", { cookie: "om_auth=forged" })).toBe(false);
    expect(checkPassword("pw", "pw")).toBe(true); expect(checkPassword("pw", "pW")).toBe(false); expect(checkPassword("", "")).toBe(false);
  });
});

describe("password-protected server", () => {
  it("blocks the API, allows health/login/status, and accepts bearer or the login cookie", async () => {
    freshEnv({ OPENMAX_PASSWORD: "s3cret" });
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/auth/status" })).body)).toEqual({ required: true, authed: false });
    expect((await app.inject({ method: "GET", url: "/api/conversations", headers: { authorization: "Bearer s3cret" } })).statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/login", payload: { password: "wrong" } }); expect(bad.statusCode).toBe(401); expect(bad.headers["set-cookie"]).toBeUndefined();
    const ok = await app.inject({ method: "POST", url: "/api/login", payload: { password: "s3cret" } }); expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]); expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Strict/); expect(cookie).not.toContain("s3cret");
    const jar = cookie.split(";")[0]!;
    expect((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: jar } })).statusCode).toBe(200);
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: jar } })).body).authed).toBe(true);
    await app.close();
  }, 20000);
  it("is open when no password is configured", async () => {
    freshEnv({ OPENMAX_PASSWORD: "" });
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).statusCode).toBe(200);
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/auth/status" })).body).required).toBe(false);
    await app.close();
  });
});
