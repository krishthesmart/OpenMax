import { execFileSync } from "node:child_process";
import os from "node:os";
import { dataPath, readJson, cfg } from "./config.js";

export interface HardwareInfo {
  platform: string; arch: string; cpu: string; ramGb: number;
  gpu: { kind: "nvidia" | "apple" | "none"; name?: string; vramGb?: number };
  memoryGb: number; tier: string;
}
const run = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };

export function detectHardware(): HardwareInfo {
  const ramGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  let gpu: HardwareInfo["gpu"] = { kind: "none" };
  let memoryGb = ramGb;
  const nv = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (nv) {
    const [name, mem] = nv.split("\n")[0]!.split(",").map((s) => s.trim());
    const vramGb = Math.round((Number(mem) / 1024) * 10) / 10;
    gpu = { kind: "nvidia", name, vramGb };
    memoryGb = vramGb;
  } else if (process.platform === "darwin" && process.arch === "arm64") {
    const mem = Number(run("sysctl", ["-n", "hw.memsize"]));
    const brand = run("sysctl", ["-n", "machdep.cpu.brand_string"]);
    gpu = { kind: "apple", name: brand };
    if (mem) memoryGb = Math.round((mem / 1024 ** 3) * 10) / 10;
  }
  return { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? "unknown", ramGb, gpu, memoryGb, tier: tierFor(memoryGb).label };
}

export interface Tier { minGb: number; maxGb: number; label: string; chat: string[]; code: string[]; vision: string[]; embed: string[] }
export function allTiers(): Tier[] { return readJson<{ tiers: Tier[] }>(dataPath("local-models.json"), { tiers: [] }).tiers; }
export function tierFor(memoryGb: number): Tier {
  const t = allTiers();
  return t.find((x) => memoryGb >= x.minGb && memoryGb < x.maxGb) ?? t[0] ?? { minGb: 0, maxGb: 9999, label: "unknown", chat: [], code: [], vision: [], embed: [] };
}
export async function loadedLocalModels(): Promise<{ name: string; sizeGb: number }[]> {
  try {
    const r = await fetch(`${cfg.OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(2000) });
    const j: any = await r.json();
    return (j.models ?? []).map((m: any) => ({ name: m.name, sizeGb: Math.round((m.size / 1024 ** 3) * 10) / 10 }));
  } catch { return []; }
}
