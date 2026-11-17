import nodemailer from "nodemailer";
import { cfg } from "../../config.js";
import { redactCards } from "../../util/redact.js";

export interface MailTransport { sendMail(m: { from: string; to: string[]; subject: string; text: string }): Promise<{ messageId?: string }> }
let override: MailTransport | undefined;
export const setMailTransportForTest = (t: MailTransport | undefined) => { override = t; };
export const smtpConfigured = () => !!override || (!!cfg.SMTP_HOST && !!cfg.SMTP_FROM);
export const SMTP_FIX = "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in .env (e.g. a Gmail app password), then restart.";
export const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(s);

export async function sendMail(to: string[], subject: string, body: string): Promise<string> {
  if (!smtpConfigured()) throw Object.assign(new Error("Email is not configured."), { fix: SMTP_FIX });
  const bad = to.filter((x) => !validEmail(x)); if (bad.length) throw new Error(`Invalid email address: ${bad.join(", ")}`);
  const t: MailTransport = override ?? (nodemailer.createTransport({ host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_PORT === 465, auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined }) as unknown as MailTransport);
  const r = await t.sendMail({ from: cfg.SMTP_FROM || "openmax@localhost", to, subject: redactCards(subject).slice(0, 200), text: redactCards(body).slice(0, 20000) });
  return r.messageId ?? "sent";
}
