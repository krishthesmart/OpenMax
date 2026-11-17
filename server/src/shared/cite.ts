/** Citation helpers shared by research / chat / notebook. */
export const citeNumbers = (text: string): number[] => [...new Set([...text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
/** Drops [n] markers that point at sources that do not exist (model hallucinated citations). */
export function stripInvalidCites(text: string, max: number): string {
  return text.replace(/\s?\[(\d{1,3})\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= max ? m : ""));
}
