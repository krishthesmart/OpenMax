import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshEnv } from "./helpers.js";
import { setEnvFileForTest, writeEnv, cfg } from "../src/config.js";
import { addRoutes } from "../src/app.js";
import "../src/routes/all.js";
import { buildApp } from "../src/app.js";
import { validateEnvUpdates } from "../src/routes/setup.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "om-setup-")); setEnvFileForTest(path.join(tmp, ".env")); freshEnv(); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
void addRoutes;

describe("setup env validation", () => {
  it("only whitelisted keys, sane values", () => {
    expect(validateEnvUpdates({ GROQ_API_KEY: "gsk_abc123", ENABLE_PAID: "true", MONTHLY_BUDGET_USD: "25" })).toEqual({ GROQ_API_KEY: "gsk_abc123", ENABLE_PAID: "true", MONTHLY_BUDGET_USD: "25" });
    expect(() => validateEnvUpdates({ PATH: "/bin" })).toThrow(/cannot be changed/);
    expect(() => validateEnvUpdates({ OPENMAX_PASSWORD: "x" })).toThrow(/cannot be changed/);
    expect(() => validateEnvUpdates({ GROQ_API_KEY: "a b" })).toThrow(/spaces/);
    expect(() => validateEnvUpdates({ GROQ_API_KEY: "a\nSMTP_PASS=x" })).toThrow(/invalid/);
    expect(() => validateEnvUpdates({ OLLAMA_URL: "javascript:alert(1)" })).toThrow(/http/);
    expect(() => validateEnvUpdates({ ENABLE_PAID: "yes" })).toThrow(/true or false/);
    expect(() => validateEnvUpdates({ MONTHLY_BUDGET_USD: "-5" })).toThrow(/non-negative/);
    expect(() => validateEnvUpdates({ MEDIA_PROVIDER: "rm" })).toThrow();
  });
});

describe("setup endpoints", () => {
  it("writeEnv preserves comments and other lines, updates in place, and appends new keys with 0600 permissions", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "# my notes\nPORT=9000\nGROQ_API_KEY=old\n");
    writeEnv({ GROQ_API_KEY: "new", NVIDIA_API_KEY: "nv" });
    const t = fs.readFileSync(path.join(tmp, ".env"), "utf8"); expect(t).toContain("# my notes"); expect(t).toContain("PORT=9000"); expect(t).toContain("GROQ_API_KEY=new"); expect(t).not.toContain("=old"); expect(t).toContain("NVIDIA_API_KEY=nv");
    expect(fs.statSync(path.join(tmp, ".env")).mode & 0o777).toBe(0o600); expect(cfg.GROQ_API_KEY).toBe("new");
  });
  it("PUT /api/setup/env saves keys, reloads config, verifies providers, and never echoes secrets; GET state exposes only booleans", async () => {
    const app = await buildApp();
    const put = await app.inject({ method: "PUT", url: "/api/setup/env", payload: { updates: { GROQ_API_KEY: "gsk_secret_value_123" } } });
    expect(put.statusCode).toBe(200); expect(put.body).not.toContain("gsk_secret_value_123"); expect(JSON.parse(put.body).saved).toEqual(["GROQ_API_KEY"]);
    const st = await app.inject({ method: "GET", url: "/api/setup/state" }); expect(st.body).not.toContain("gsk_secret_value_123");
    const s = JSON.parse(st.body); expect(s.keys.GROQ_API_KEY).toBe(true); expect(s.hardware.memoryGb).toBeGreaterThan(0); expect(s.ollama.recommended.length).toBeGreaterThan(0); expect(s.done).toBe(false);
    const bad = await app.inject({ method: "PUT", url: "/api/setup/env", payload: { updates: { SMTP_PASS: "x" } } }); expect(bad.statusCode).toBe(400);
    await app.inject({ method: "POST", url: "/api/setup/complete" }); expect(JSON.parse((await app.inject({ method: "GET", url: "/api/setup/state" })).body).done).toBe(true);
    await app.close();
  });
  it("ollama pull rejects odd model names; usage and think endpoints respond", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "POST", url: "/api/ollama/pull", payload: { model: "x; rm -rf /" } })).statusCode).toBe(400);
    const pull = await app.inject({ method: "POST", url: "/api/ollama/pull", payload: { model: "llama3.2:1b" } }); expect(pull.body).toContain("event: done");
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/usage?range=day" })).body).range).toBe("day");
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/think/estimate" })).body).seconds).toBeGreaterThan(0);
    const h = JSON.parse((await app.inject({ method: "GET", url: "/api/health" })).body); expect(h.providers.every((p: any) => "capWarn" in p)).toBe(true);
    await app.close();
  });
});
