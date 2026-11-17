function luhn(d: string): boolean {
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
/** Replace Luhn-valid 13–19 digit sequences (card numbers) so they are never stored. */
export function redactCards(text: string): string {
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => { const d = m.replace(/[ -]/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) ? "[card number redacted]" : m; });
}
export const looksLikeCard = (text: string) => redactCards(text) !== text;
