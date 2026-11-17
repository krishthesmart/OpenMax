import { describe, expect, it } from "vitest";
import { classifyTyped, evaluateGate, type ElementInfo } from "../src/modules/agent/gates.js";
import { buildIcs, fold, icsDate } from "../src/modules/agent/ics.js";

const el = (o: Partial<ElementInfo> = {}): ElementInfo => ({ ref: 1, tag: "input", ...o });
const gate = (tool: string, args: any, element?: ElementInfo, extra: any = {}) => evaluateGate({ tool, args, element, ...extra });

describe("approval gates: sending", () => {
  it("email ALWAYS needs approval, even to a known recipient; new recipients are flagged", () => {
    const g1 = gate("send_email", { to: ["new@x.com"], subject: "Hi", body: "b" }, undefined, { knownRecipients: [] });
    expect(g1).toMatchObject({ action: "approve", kind: "send_message" }); expect((g1 as any).flags[0]).toMatch(/new recipient: new@x.com/);
    const g2 = gate("send_email", { to: ["Old@x.com"], subject: "Hi", body: "b" }, undefined, { knownRecipients: ["old@x.com"] });
    expect(g2).toMatchObject({ action: "approve" }); expect((g2 as any).flags).toEqual([]);
    expect((gate("send_email", { to: Array.from({ length: 7 }, (_, i) => `a${i}@x.com`), subject: "s", body: "b" }) as any).flags).toContain("many recipients");
  });
});

describe("approval gates: deleting", () => {
  it("file deletes need approval", () => { expect(gate("file_delete", { path: "a.txt" })).toMatchObject({ action: "approve", kind: "delete" }); });
});

describe("approval gates: typing", () => {
  it("never types passwords, card numbers or SSNs (hard block, no approval offered)", () => {
    expect(gate("browser_type", { ref: 1, text: "hunter2" }, el({ type: "password" })).action).toBe("block");
    expect(gate("browser_type", { ref: 1, text: "hunter2" }, el({ name: "user_password" })).action).toBe("block");
    expect(gate("browser_type", { ref: 1, text: "4242 4242 4242 4242" }, el({ name: "q" })).action).toBe("block");
    expect(gate("browser_type", { ref: 1, text: "123" }, el({ name: "cvv" })).action).toBe("block");
    expect(gate("browser_type", { ref: 1, text: "123-45-6789" }, el()).action).toBe("block");
    expect((gate("browser_type", { ref: 1, text: "x" }, el({ type: "password" })) as any).reason).toMatch(/never types passwords/);
  });
  it("personal data needs approval (value patterns and field hints)", () => {
    for (const text of ["sam@example.com", "+1 (415) 555-2671", "04/12/1990", "221 Baker Street"]) expect(gate("browser_type", { ref: 1, text }, el({ name: "q" }))).toMatchObject({ action: "approve", kind: "personal_data" });
    expect(gate("browser_type", { ref: 1, text: "Sam" }, el({ name: "first_name", label: "First name" }))).toMatchObject({ action: "approve", kind: "personal_data" });
  });
  it("ordinary text is allowed; Enter inside a form is a submit and needs approval", () => {
    expect(gate("browser_type", { ref: 1, text: "best pizza near me" }, el({ name: "q", inForm: false }))).toEqual({ action: "allow" });
    expect(gate("browser_type", { ref: 1, text: "order 12345" }, el({ name: "q" }))).toEqual({ action: "allow" });
    expect(gate("browser_type", { ref: 1, text: "pizza", enter: true }, el({ name: "q", inForm: true }))).toMatchObject({ action: "approve", kind: "irreversible" });
    expect(gate("browser_type", { ref: 1, text: "pizza", enter: true }, el({ name: "q", inForm: false }))).toEqual({ action: "allow" });
  });
  it("classifyTyped distinguishes secrets from personal data", () => {
    expect(classifyTyped("4111111111111111")).toEqual({ secret: "card" });
    expect(classifyTyped("a@b.co")).toEqual({ personal: "email address" });
    expect(classifyTyped("hello")).toEqual({});
    expect(classifyTyped("5551234567890123456789")).toEqual({});
  });
});

describe("approval gates: clicking", () => {
  it("payment buttons are payment gates", () => {
    for (const text of ["Place order", "Buy now", "Pay $19.99", "Complete purchase", "Subscribe", "Checkout", "Donate"]) expect(gate("browser_click", { ref: 3 }, el({ tag: "button", text }))).toMatchObject({ action: "approve", kind: "payment" });
  });
  it("submitting / destructive / publishing buttons need approval", () => {
    for (const text of ["Submit", "Delete account", "Send message", "Post", "Publish", "Confirm", "Sign up", "Cancel my subscription"]) expect(gate("browser_click", { ref: 3 }, el({ tag: "button", text }))).toMatchObject({ action: "approve", kind: "irreversible" });
    expect(gate("browser_click", { ref: 3 }, el({ tag: "input", type: "submit", text: "Go" }))).toMatchObject({ action: "approve" });
    expect(gate("browser_click", { ref: 3 }, el({ tag: "button", text: "Next", inForm: true }))).toMatchObject({ action: "approve" });
  });
  it("plain links and buttons outside forms are allowed", () => {
    expect(gate("browser_click", { ref: 4 }, el({ tag: "a", text: "About us" }))).toEqual({ action: "allow" });
    expect(gate("browser_click", { ref: 4 }, el({ tag: "button", text: "Show more", inForm: false }))).toEqual({ action: "allow" });
  });
  it("summaries name the page host", () => {
    expect((gate("browser_click", { ref: 3 }, el({ tag: "button", text: "Buy now" }), { pageUrl: "https://shop.example.com/cart" }) as any).summary).toContain("shop.example.com");
  });
});

describe("approval gates: harmless tools", () => {
  it("search, fetch, file read/write, calendar, memory, finish are allowed", () => {
    for (const t of ["web_search", "fetch_page", "browser_open", "browser_read", "file_list", "file_read", "file_write", "calendar_add", "memory_recall", "memory_save", "finish"]) expect(gate(t, {}).action).toBe("allow");
  });
});

describe("ICS", () => {
  it("builds a valid, escaped, folded event", () => {
    const ics = buildIcs({ uid: "u1@openmax", title: "Lunch, with; Sam\\", start: new Date("2026-03-14T15:00:00Z"), end: new Date("2026-03-14T16:30:00Z"), description: "Line1\nLine2 " + "x".repeat(120), location: "Café", stamp: new Date("2026-01-01T00:00:00Z") });
    expect(ics).toContain("BEGIN:VCALENDAR\r\n"); expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("DTSTART:20260314T150000Z"); expect(ics).toContain("DTEND:20260314T163000Z"); expect(ics).toContain("DTSTAMP:20260101T000000Z");
    expect(ics).toContain("SUMMARY:Lunch\\, with\; Sam\\\\");
    expect(ics).toContain("DESCRIPTION:Line1\\nLine2");
    for (const l of ics.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });
  it("defaults to a 1-hour event; all-day events use VALUE=DATE; fold never splits a multibyte char", () => {
    expect(buildIcs({ uid: "u", title: "t", start: new Date("2026-03-14T15:00:00Z") })).toContain("DTEND:20260314T160000Z");
    expect(buildIcs({ uid: "u", title: "t", start: new Date("2026-03-14T00:00:00Z"), allDay: true })).toContain("DTSTART;VALUE=DATE:20260314");
    const f = fold("é".repeat(60)); expect(f.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(f.replace(/\r\n /g, "")).toBe("é".repeat(60));
    expect(icsDate(new Date("2026-03-14T15:00:00.123Z"))).toBe("20260314T150000Z");
  });
});
