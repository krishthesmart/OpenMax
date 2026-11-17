import { beforeEach, describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { allTiers, detectHardware, tierFor } from "../src/hardware.js";

describe("hardware tiers", () => {
  beforeEach(() => freshEnv());
  it("maps memory to the right recommendation tier (8 / 16 / 24 / 48+)", () => {
    expect(allTiers().map((t) => t.label)).toEqual(["8 GB", "16 GB", "24 GB", "48 GB+"]);
    for (const [gb, label] of [[4, "8 GB"], [8, "8 GB"], [11.9, "8 GB"], [12, "16 GB"], [15.6, "16 GB"], [16, "16 GB"], [19.9, "16 GB"], [24, "24 GB"], [32, "24 GB"], [48, "48 GB+"], [96, "48 GB+"]] as const) expect(tierFor(gb).label, `${gb} GB`).toBe(label);
  });
  it("recommends chat, code, vision and embedding models for every tier", () => {
    for (const t of allTiers()) for (const k of ["chat", "code", "vision", "embed"] as const) expect(t[k].length, `${t.label}/${k}`).toBeGreaterThan(0);
  });
  it("detects this machine without throwing and reports a tier", () => {
    const hw = detectHardware();
    expect(hw.memoryGb).toBeGreaterThan(0); expect(["nvidia", "apple", "none"]).toContain(hw.gpu.kind); expect(allTiers().map((t) => t.label)).toContain(hw.tier);
  });
});
