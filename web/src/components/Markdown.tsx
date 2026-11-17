import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { memo } from "react";

export interface CiteSource { n: number; title: string; url?: string; snippet?: string }

function CopyBtn({ text }: { text: string }) {
  return <button className="absolute right-2 top-2 rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-dim opacity-0 transition hover:text-ink group-hover:opacity-100" onClick={() => navigator.clipboard.writeText(text)}>copy</button>;
}

export const Markdown = memo(function Markdown({ text, sources, onCite }: { text: string; sources?: CiteSource[]; onCite?: (n: number) => void }) {
  const max = sources?.length ?? 0;
  const prepared = max ? text.replace(/\[(\d{1,3})\](?!\()/g, (m, n) => (Number(n) >= 1 && Number(n) <= max ? `[${n}](#cite-${n})` : m)) : text;
  return (
    <div className="prose-om">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a({ href, children }) {
            if (href?.startsWith("#cite-")) {
              const n = Number(href.slice(6)); const s = sources?.find((x) => x.n === n);
              return <span className="cite" title={s ? `${s.title}${s.url ? "\n" + s.url : ""}` : ""} onClick={() => onCite?.(n)}>{n}</span>;
            }
            return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
          pre({ children, ...p }) {
            const code = (children as any)?.props?.children;
            return <div className="group relative"><pre {...p}>{children}</pre><CopyBtn text={typeof code === "string" ? code : Array.isArray(code) ? code.join("") : ""} /></div>;
          },
        }}>{prepared}</ReactMarkdown>
    </div>
  );
});
