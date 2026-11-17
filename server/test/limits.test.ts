import { describe, expect, it, beforeEach } from "vitest";
import * as L from "../src/providers/limits.js";

describe("rate limits", () => {
  let t = 1_000_000;
  beforeEach(() => { L.resetLimits(); t = 1_000_000; L.setClock(() => t); });
  it("429 starts a cooldown for the retry-after window then expires", () => {
    L.record429("groq", 40);
    expect(L.cooldownRemaining("groq")).toBe(40);
    expect(L.isCoolingDown("groq")).toBe(true);
    t += 41_000;
    expect(L.isCoolingDown("groq")).toBe(false);
    expect(L.count429("groq")).toBe(1);
  });
  it("uses a conservative default when no retry-after is given", () => {
    L.record429("nvidia");
    expect(L.cooldownRemaining("nvidia")).toBe(L.DEFAULT_COOLDOWN_SEC);
  });
  it("parses duration headers", () => {
    expect(L.parseDuration("7.66s")).toBeCloseTo(7.66);
    expect(L.parseDuration("2m59.56s")).toBeCloseTo(179.56);
    expect(L.parseDuration("30")).toBe(30);
    expect(L.parseDuration("120ms")).toBeCloseTo(0.12);
    expect(L.parseDuration("garbage")).toBeUndefined();
  });
  it("an exhausted request bucket with a known reset blocks until reset", () => {
    L.recordHeaders("groq", new Headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-limit-requests": "30", "x-ratelimit-reset-requests": "12s" }));
    expect(L.cooldownRemaining("groq")).toBe(12);
    t += 13_000;
    expect(L.cooldownRemaining("groq")).toBe(0);
  });
  it("cap percentage and 80% warning", () => {
    expect(L.capPercent(80, 100)).toBe(80);
    expect(L.nearCap(L.capPercent(80, 100))).toBe(true);
    expect(L.nearCap(L.capPercent(79, 100))).toBe(false);
    expect(L.capPercent(5, undefined)).toBeUndefined();
  });
});
