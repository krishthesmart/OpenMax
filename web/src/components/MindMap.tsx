interface N { title: string; children?: N[] }
interface P { n: N; x: number; y: number; depth: number; kids: P[] }
function layout(n: N, depth: number, state: { y: number }): P {
  const kids = (n.children ?? []).map((c) => layout(c, depth + 1, state));
  const y = kids.length ? (kids[0]!.y + kids[kids.length - 1]!.y) / 2 : (state.y += 34);
  return { n, x: depth * 210, y, depth, kids };
}
const COLORS = ["#7c9cff", "#b48cff", "#4ade80", "#fbbf24", "#f87171", "#38bdf8"];
export function MindMap({ root }: { root: N }) {
  const p = layout(root, 0, { y: 0 });
  const nodes: P[] = []; const edges: [P, P, number][] = [];
  const walk = (a: P, branch: number) => { nodes.push(a); a.kids.forEach((k, i) => { const b = a.depth === 0 ? i : branch; edges.push([a, k, b]); walk(k, b); }); };
  walk(p, 0);
  const maxY = Math.max(...nodes.map((x) => x.y)) + 30, maxX = Math.max(...nodes.map((x) => x.x)) + 220;
  return (
    <div className="overflow-auto rounded-lg border border-line bg-bg">
      <svg width={maxX + 20} height={maxY + 20} className="block">
        {edges.map(([a, b, br], i) => <path key={i} d={`M${a.x + 190},${a.y} C${a.x + 205},${a.y} ${b.x - 15},${b.y} ${b.x},${b.y}`} stroke={COLORS[br % COLORS.length]} strokeWidth={1.6} fill="none" opacity={0.7} transform="translate(10,10)" />)}
        {nodes.map((x, i) => {
          const branch = edges.find(([, k]) => k === x)?.[2] ?? 0; const c = x.depth === 0 ? "#e7e9ee" : COLORS[branch % COLORS.length]!;
          return <g key={i} transform={`translate(${x.x + 10},${x.y - 12 + 10})`}><rect width={190} height={24} rx={7} fill="#12141a" stroke={c} /><text x={8} y={16} fontSize={11.5} fill="#e7e9ee" fontFamily="system-ui">{x.n.title.length > 30 ? x.n.title.slice(0, 29) + "…" : x.n.title}<title>{x.n.title}</title></text></g>;
        })}
      </svg>
    </div>
  );
}
