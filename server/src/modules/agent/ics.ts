const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** RFC 5545 line folding at 75 octets (continuation lines start with a space). */
export function fold(line: string): string {
  const enc = new TextEncoder(); if (enc.encode(line).length <= 75) return line;
  const out: string[] = []; let cur = "", bytes = 0, limit = 75;
  for (const ch of line) { const b = enc.encode(ch).length; if (bytes + b > limit) { out.push(cur); cur = " "; bytes = 1; limit = 75; } cur += ch; bytes += b; }
  out.push(cur); return out.join("\r\n");
}
export const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
export interface IcsEvent { uid: string; title: string; start: Date; end?: Date; description?: string; location?: string; allDay?: boolean; stamp?: Date }
export function buildIcs(e: IcsEvent): string {
  const end = e.end ?? new Date(e.start.getTime() + 3600_000);
  const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenMax//Agent//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${icsDate(e.stamp ?? new Date())}`,
    e.allDay ? `DTSTART;VALUE=DATE:${day(e.start)}` : `DTSTART:${icsDate(e.start)}`, e.allDay ? `DTEND;VALUE=DATE:${day(e.end ?? new Date(e.start.getTime() + 86400_000))}` : `DTEND:${icsDate(end)}`,
    `SUMMARY:${esc(e.title)}`, ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []), ...(e.location ? [`LOCATION:${esc(e.location)}`] : []), "END:VEVENT", "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}
