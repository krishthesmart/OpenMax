import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function useFetch<T = any>(url: string | null, deps: unknown[] = [], refreshMs = 0) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try { setData(await api.get<T>(url)); setError(undefined); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [url]);
  useEffect(() => { void load(); if (refreshMs) { const t = setInterval(load, refreshMs); return () => clearInterval(t); } }, [load, refreshMs, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: load, setData };
}
export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => { const t = setInterval(() => ref.current(), ms); return () => clearInterval(t); }, [ms]);
}
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(map); ref.current = map;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const k = `${e.metaKey || e.ctrlKey ? "mod+" : ""}${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`;
      const f = ref.current[k]; if (f) { e.preventDefault(); f(e); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, []);
}
