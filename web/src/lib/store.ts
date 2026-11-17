import { useSyncExternalStore } from "react";

type Mode = string; // "auto" | "local-first" | "cost-saver" | "manual:<ref>"
interface Prefs { mode: Mode; think: boolean; sidebarOpen: boolean }
const KEY = "om.prefs";
let state: Prefs = { mode: "auto", think: false, sidebarOpen: true };
try { state = { ...state, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { /* ignore */ }
const subs = new Set<() => void>();
export function setPrefs(p: Partial<Prefs>) {
  state = { ...state, ...p };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  subs.forEach((f) => f());
}
export const getPrefs = () => state;
export function usePrefs(): Prefs {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
}
