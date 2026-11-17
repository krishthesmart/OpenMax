import { looksLikeCard } from "../../util/redact.js";

/**
 * Approval gates. This module is the single, pure source of truth for "does this action need a human click".
 * It is called by the tool executor BEFORE any side effect; the model cannot influence or bypass it.
 */
export type ApprovalKind = "send_message" | "delete" | "payment" | "personal_data" | "irreversible" | "question";
export interface ElementInfo { ref: number; tag: string; type?: string; text?: string; name?: string; label?: string; placeholder?: string; inForm?: boolean; formAction?: string }
export interface GateInput { tool: string; args: Record<string, any>; element?: ElementInfo; knownRecipients?: string[]; pageUrl?: string }
export type GateDecision =
  | { action: "allow" }
  | { action: "approve"; kind: ApprovalKind; summary: string; flags: string[] }
  | { action: "block"; reason: string };

const PAY = /\b(pay(ment)?|buy( now)?|purchase|place (your |my )?order|checkout|check out|complete (the )?(order|purchase)|subscribe|donate|confirm (payment|order|purchase)|book now|add (a )?card|upgrade|start (free )?trial|authorize)\b/i;
const IRREVERSIBLE = /\b(delete|remove|erase|destroy|cancel (my |the |your )?(account|subscription|order|booking)|send|submit|post|publish|confirm|sign ?up|register|unsubscribe|transfer|withdraw|apply|agree|accept|share|invite|reply|tweet)\b/i;
const SECRET_FIELD = /pass(word|wd)?\b|pwd|cvv|cvc|card.?(number|no|num)|cc-?num|ccnum|iban|routing|account.?number|\bssn\b|social.?security|security.?code|one.?time|otp|2fa|pin\b/i;
const PERSONAL_FIELD = /e-?mail|phone|tel\b|mobile|address|street|city|zip|postal|post.?code|birth|dob|full.?name|first.?name|last.?name|surname|given.?name|family.?name/i;

export const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
export const EMAIL = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;
export const PHONE = /(?<![\d-])(?:\+?\d[\s().-]{0,2}){9,14}\d(?![\d-])/;
export const DOB = /\b(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-](19|20)\d{2}\b/;
export const STREET = /\b\d{1,5}\s+[A-Za-z0-9.\s]{3,30}\s(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/i;

export const fieldHints = (e?: ElementInfo) => [e?.type, e?.name, e?.label, e?.placeholder].filter(Boolean).join(" ");

export interface TypedClass { secret?: "password" | "card" | "ssn"; personal?: string }
/** What kind of sensitive data is this text/field? Secrets are never typed by the agent; personal data needs approval. */
export function classifyTyped(value: string, el?: ElementInfo): TypedClass {
  const hint = fieldHints(el);
  if (el?.type === "password" || /pass(word|wd)?\b|pwd/i.test(hint)) return { secret: "password" };
  if (looksLikeCard(value) || /card.?(number|no|num)|cc-?num|ccnum|cvv|cvc|security.?code/i.test(hint)) return { secret: "card" };
  if (SSN.test(value) || /\bssn\b|social.?security/i.test(hint)) return { secret: "ssn" };
  if (SECRET_FIELD.test(hint)) return { secret: "password" };
  if (EMAIL.test(value)) return { personal: "email address" };
  if (DOB.test(value)) return { personal: "date of birth" };
  if (STREET.test(value)) return { personal: "street address" };
  const digits = value.replace(/\D/g, "");
  if (PHONE.test(value) && digits.length >= 10 && digits.length <= 15) return { personal: "phone number" };
  if (PERSONAL_FIELD.test(hint)) return { personal: `a "${(el?.label || el?.name || el?.placeholder || "personal").slice(0, 30)}" field` };
  return {};
}

const label = (e?: ElementInfo) => (e?.text || e?.label || e?.name || e?.placeholder || e?.tag || "element").trim().slice(0, 60);
const isSubmitControl = (e?: ElementInfo) => !!e && (e.type === "submit" || (e.tag === "button" && e.inForm && (e.type === undefined || e.type === "" || e.type === "submit")) || (e.tag === "input" && /submit|image/.test(e.type ?? "")));

export function evaluateGate(g: GateInput): GateDecision {
  const { tool, args, element } = g;
  switch (tool) {
    case "send_email": {
      const to: string[] = ([] as string[]).concat(args.to ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      const known = new Set((g.knownRecipients ?? []).map((x) => x.toLowerCase()));
      const fresh = to.filter((x) => !known.has(x));
      const flags = [...(fresh.length ? [`new recipient${fresh.length > 1 ? "s" : ""}: ${fresh.join(", ")}`] : []), ...(to.length > 5 ? ["many recipients"] : [])];
      return { action: "approve", kind: "send_message", summary: `Send email to ${to.join(", ") || "(no recipient)"} — "${String(args.subject ?? "").slice(0, 80)}"`, flags };
    }
    case "file_delete": return { action: "approve", kind: "delete", summary: `Permanently delete ${String(args.path)} from the agent sandbox`, flags: [] };
    case "browser_type": {
      const c = classifyTyped(String(args.text ?? ""), element);
      if (c.secret) return { action: "block", reason: c.secret === "password" ? "The agent never types passwords. Sign in yourself in a normal browser, or give it a task that does not require login." : c.secret === "card" ? "The agent never enters payment card details. Complete the payment yourself." : "The agent never enters government ID numbers." };
      if (c.personal) return { action: "approve", kind: "personal_data", summary: `Type ${c.personal} into "${label(element)}"${g.pageUrl ? ` on ${hostOf(g.pageUrl)}` : ""}`, flags: [] };
      if (args.enter && element?.inForm) return { action: "approve", kind: "irreversible", summary: `Press Enter in "${label(element)}", which submits the form${g.pageUrl ? ` on ${hostOf(g.pageUrl)}` : ""}`, flags: [] };
      return { action: "allow" };
    }
    case "browser_click": {
      const text = `${element?.text ?? ""} ${element?.label ?? ""} ${element?.name ?? ""} ${element?.type ?? ""}`;
      if (PAY.test(text)) return { action: "approve", kind: "payment", summary: `Click "${label(element)}", which may spend money${g.pageUrl ? ` on ${hostOf(g.pageUrl)}` : ""}`, flags: [] };
      if (IRREVERSIBLE.test(text) || isSubmitControl(element)) return { action: "approve", kind: "irreversible", summary: `Click "${label(element)}", which may submit or change something${g.pageUrl ? ` on ${hostOf(g.pageUrl)}` : ""}`, flags: [] };
      return { action: "allow" };
    }
    case "browser_select": {
      const c = classifyTyped(String(args.value ?? ""), element);
      return c.personal ? { action: "approve", kind: "personal_data", summary: `Choose ${c.personal} in "${label(element)}"`, flags: [] } : { action: "allow" };
    }
    default: return { action: "allow" };
  }
}
function hostOf(u: string) { try { return new URL(u).host; } catch { return u; } }
export const GATED_TOOLS = ["send_email", "file_delete", "browser_type", "browser_click", "browser_select"] as const;
