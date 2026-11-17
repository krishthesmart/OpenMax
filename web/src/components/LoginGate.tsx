import { useEffect, useState, type ReactNode } from "react";

/** Shows a password prompt when the server has OPENMAX_PASSWORD set and this browser has no valid session. */
export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "login">("checking");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/auth/status").then((r) => r.json()).then((s) => setState(!s.required || s.authed ? "ok" : "login")).catch(() => setState("ok"));
  }, []);
  const submit = async () => {
    setErr("");
    const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (r.ok) setState("ok"); else setErr((await r.json().catch(() => ({}))).error ?? "Could not sign in.");
  };
  if (state === "checking") return <div className="grid h-full place-items-center text-dim">Loading…</div>;
  if (state === "ok") return <>{children}</>;
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="card w-full max-w-sm space-y-3 p-6">
        <div className="text-lg font-semibold">OpenMax</div>
        <p className="text-[13px] text-dim">This instance is password protected.</p>
        <input className="input" type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <p className="text-[13px] text-bad">{err}</p>}
        <button className="btn btn-primary w-full justify-center" disabled={!pw} onClick={submit}>Sign in</button>
      </div>
    </div>
  );
}
