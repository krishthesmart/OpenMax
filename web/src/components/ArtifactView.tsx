import { useMemo, useState } from "react";
import { transform } from "sucrase";
import { extForArtifact, type ParsedArtifact } from "../../../server/src/shared/artifacts";
import { Markdown } from "./Markdown";

function reactDoc(code: string): string {
  let compiled = "";
  try { compiled = transform(code, { transforms: ["jsx", "typescript", "imports"], jsxRuntime: "classic", production: true }).code; }
  catch (e: any) { return errDoc(`Could not compile this component: ${e.message}`); }
  const bundle = new URL("/vendor/react-bundle.js", location.href).href;
  const js = JSON.stringify(compiled).replace(/<\//g, "<\\/");
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif;background:#fff;color:#111}#err{white-space:pre-wrap;color:#b00020;padding:12px;font:12px monospace}</style><div id="root"></div><div id="err"></div>
<script type="module">import {React,jsx,createRoot} from ${JSON.stringify(bundle)};
const mods={"react":React,"react/jsx-runtime":jsx,"react-dom/client":{createRoot}};
const require=(n)=>{if(!mods[n])throw new Error("Module not available in preview: "+n);return mods[n]};
const module={exports:{}};
try{(new Function("require","exports","module","React",${js}))(require,module.exports,module,React);
const C=module.exports.default||module.exports.App||Object.values(module.exports).find(v=>typeof v==="function");
if(!C)throw new Error("Export a React component as the default export.");
createRoot(document.getElementById("root")).render(React.createElement(C));}catch(e){document.getElementById("err").textContent=String(e&&e.stack||e)}
window.addEventListener("error",e=>{document.getElementById("err").textContent=String(e.message)});</script>`;
}
const errDoc = (m: string) => `<!doctype html><body style="font:13px monospace;color:#b00020;padding:12px">${m.replace(/</g, "&lt;")}</body>`;

export function previewDoc(a: Pick<ParsedArtifact, "kind" | "content">): string | undefined {
  if (a.kind === "html") return a.content;
  if (a.kind === "svg") return `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${a.content}</body>`;
  if (a.kind === "react") return reactDoc(a.content);
  return undefined;
}

export function ArtifactView({ versions, title, kind, lang, streaming, onCanvas }: { versions: string[]; title: string; kind: ParsedArtifact["kind"]; lang?: string; streaming?: boolean; onCanvas?: (content: string) => void }) {
  const [vi, setVi] = useState<number | null>(null);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const idx = vi ?? versions.length - 1;
  const content = versions[idx] ?? "";
  const canPreview = kind === "html" || kind === "svg" || kind === "react" || kind === "markdown";
  const doc = useMemo(() => (streaming ? undefined : previewDoc({ kind, content })), [kind, content, streaming]);
  const download = () => { const url = URL.createObjectURL(new Blob([content], { type: "text/plain" })); const a = document.createElement("a"); a.href = url; a.download = `${title.replace(/\W+/g, "-").toLowerCase()}.${extForArtifact({ kind, lang })}`; a.click(); URL.revokeObjectURL(url); };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="truncate font-medium">{title}</span><span className="chip">{kind}{lang ? ` · ${lang}` : ""}</span>
        {versions.length > 1 && (
          <span className="flex items-center gap-1 text-[12px] text-dim">
            <button className="btn btn-ghost !px-1.5 !py-0" disabled={idx === 0} onClick={() => setVi(idx - 1)}>‹</button>v{idx + 1}/{versions.length}
            <button className="btn btn-ghost !px-1.5 !py-0" disabled={idx === versions.length - 1} onClick={() => setVi(idx + 1)}>›</button>
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {canPreview && <><button className={`btn !py-0.5 ${tab === "preview" ? "btn-primary" : ""}`} onClick={() => setTab("preview")}>Preview</button><button className={`btn !py-0.5 ${tab === "code" ? "btn-primary" : ""}`} onClick={() => setTab("code")}>Code</button></>}
          <button className="btn !py-0.5" onClick={() => navigator.clipboard.writeText(content)}>Copy</button>
          <button className="btn !py-0.5" onClick={download}>Download</button>
          {onCanvas && !streaming && <button className="btn btn-primary !py-0.5" onClick={() => onCanvas(content)}>Open in Canvas</button>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {tab === "preview" && kind === "markdown" ? <div className="p-5"><Markdown text={content} /></div>
          : tab === "preview" && canPreview ? (streaming ? <div className="p-5 text-dim">Writing…</div> : <iframe title={title} className="h-full w-full bg-white" sandbox="allow-scripts" srcDoc={doc} />)
          : <pre className="m-0 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{content}</pre>}
      </div>
    </div>
  );
}
