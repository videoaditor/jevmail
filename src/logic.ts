// Pure logic: no network, no database. Everything here is covered by test/logic.test.ts.

export interface Lead {
  email: string;
  name: string | null;
  source: string | null;
  facts: Record<string, string>;
  /** true = opted out in the lead platform/CSV → never mailed again */
  unsubscribed?: boolean;
}

// ---------------------------------------------------------------------------
// Reading the owner's Telegram message
// ---------------------------------------------------------------------------

export type ParsedMail = { ok: true; filter: string | null; subject: string; body: string } | { ok: false; error: string };

/**
 * Optional first line "to: <who should get it>", then the subject line, then the body.
 * The owner's words are never changed.
 */
export function parseMail(text: string): ParsedMail {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  let filter: string | null = null;
  const to = lines[0]?.match(/^\s*to\s*:\s*(.*)$/i);
  if (to) {
    filter = to[1].trim() || null;
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }
  const subject = (lines.shift() ?? "").replace(/^\s*subject\s*:\s*/i, "").trim();
  const body = lines.join("\n").trim();
  if (!subject) return { ok: false, error: "I couldn't find a subject. Put the subject on the first line, then the email below it." };
  if (subject.length > 150) return { ok: false, error: "The first line is the subject, and it's very long. Put a short subject on its own first line." };
  if (body.length < 20) return { ok: false, error: "The email body is missing or very short. First line = subject, then the email text below." };
  return { ok: true, filter, subject, body };
}

// ---------------------------------------------------------------------------
// CSV import (exports from Shopify, Klaviyo, Mailchimp, Excel, Google Sheets …)
// ---------------------------------------------------------------------------

/** RFC 4180 with quotes; auto-detects "," vs ";" (European Excel exports use ";"). */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((v) => v.trim()));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = (e: unknown): string | null => {
  const s = String(e ?? "").trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
};

const CONSENT_COL = /accepts.?(email.?)?marketing|marketing.?consent|email.?subscription|subscri|consent|opt.?in/i;
const NO_CONSENT = /^(no|false|0|n|unsubscribed|not.?subscribed|never.?subscribed|nein|cleaned|bounced)$/i;

export function csvToLeads(rows: string[][], source: string | null): { leads: Lead[]; noEmail: number; noConsent: number } {
  const [header, ...data] = rows;
  const h = (header ?? []).map((s) => s.trim());
  const emailCol = h.findIndex((c) => /e-?mail/i.test(c) && !CONSENT_COL.test(c));
  const nameCol = ["first name", "firstname", "first_name", "vorname", "name", "full name"]
    .map((n) => h.findIndex((c) => c.toLowerCase() === n))
    .find((i) => i >= 0) ?? -1;
  const consentCols = h.map((c, i) => (CONSENT_COL.test(c) ? i : -1)).filter((i) => i >= 0);
  const leads: Lead[] = [];
  let noEmail = 0;
  let noConsent = 0;
  for (const r of data) {
    const email = emailCol >= 0 ? normEmail(r[emailCol]) : null;
    if (!email) {
      noEmail++;
      continue;
    }
    const optedOut = consentCols.some((i) => NO_CONSENT.test((r[i] ?? "").trim()));
    if (optedOut) noConsent++;
    const facts: Record<string, string> = {};
    h.forEach((col, i) => {
      const v = (r[i] ?? "").trim();
      if (col && v && i !== emailCol && i !== nameCol) facts[col] = v;
    });
    leads.push({ email, name: nameCol >= 0 ? (r[nameCol] ?? "").trim() || null : null, source, facts, ...(optedOut ? { unsubscribed: true } : {}) });
  }
  return { leads, noEmail, noConsent };
}

// ---------------------------------------------------------------------------
// Ranking with Jev (TypeSafe) — https://docs.typesafe.ai/api.md
// ---------------------------------------------------------------------------

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

const VALUE_LEVELS = [
  "No connection to anything this person signed up for or told us",
  "Marginally interesting to them",
  "Hits a topic they signed up for or mentioned",
  "Hits exactly their problem, goal or wish",
];

/** Contact details never go to the model: it ranks people, it doesn't need to know who they are. */
const isIdentityKey = (key: string) => {
  const k = key.toLowerCase().replace(/[^a-z]/g, "");
  return /email|phone|mobile|address|street|password/.test(k) || /^(first|last|full|vor|nach)?name$|^(zip|postal|post)(code)?$|^ip$/.test(k);
};
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** What Jev sees about one person: where they signed up, what that page promised, and what they told us. */
export function personState(lead: { source: string | null; facts: string | Record<string, unknown> }, funnels: Record<string, string>) {
  let facts: Record<string, unknown> = {};
  try {
    facts = typeof lead.facts === "string" ? JSON.parse(lead.facts) : lead.facts;
  } catch {
    /* unreadable facts = no facts */
  }
  const clean: Record<string, string> = {};
  let budget = 2000; // ponytail: ~500 tokens per person keeps ranking cheap; raise if leads carry long quiz answers
  for (const [k, v] of Object.entries(facts ?? {})) {
    if (isIdentityKey(k) || v === null || v === undefined || v === "") continue;
    const s = cut(typeof v === "string" ? v : JSON.stringify(v), 200);
    if ((budget -= k.length + s.length) < 0) break;
    clean[k] = s;
  }
  const src = lead.source ?? "";
  return { signed_up_via: src || "unknown", that_page_offered: funnels[src] ?? funnels.default ?? "unknown", facts: clean };
}

export function buildJevRequest(mail: { subject: string; body: string }, person: object, business: string, filter: string | null) {
  const questions: Record<string, unknown> = {
    value: {
      type: "score",
      instructions:
        "How much value does this person get from `email`? Judge only from the facts in `person`: where they signed up, what that page offered them, and what they told us. `business` describes the sender.",
      criteria: VALUE_LEVELS,
    },
  };
  if (filter)
    questions.filter = {
      type: "noul",
      instructions: `Does this apply to the person: ${filter}?`,
      criteria: { true: "The facts in `person` clearly show it", false: "The facts don't show it, or it would be a guess" },
    };
  return { model: JEV_MODEL, state: { business, email: { subject: mail.subject, body: cut(mail.body, 4000) }, person }, questions };
}

/** Returns value 0..1 and filter_p 0..1 (null without filter), or null if the answer is unusable. */
export function parseJev(json: unknown, hasFilter: boolean): { value: number; filter_p: number | null } | null {
  const a = (json as { answers?: Record<string, { score?: unknown; noul?: unknown }> } | null)?.answers;
  const score = a?.value?.score;
  if (typeof score !== "number" || !(score >= 0 && score <= VALUE_LEVELS.length - 1)) return null;
  let filter_p: number | null = null;
  if (hasFilter) {
    const n = a?.filter?.noul;
    if (typeof n !== "number" || !(n >= 0 && n <= 1)) return null;
    filter_p = n;
  }
  return { value: score / (VALUE_LEVELS.length - 1), filter_p };
}

/** 429/529 = slow down, other 4xx = our request or key is wrong, rest = try again later. */
export const jevErrorKind = (status: number): "rate_limited" | "bad_request" | "transient" =>
  status === 429 || status === 529 ? "rate_limited" : status >= 400 && status < 500 && status !== 408 ? "bad_request" : "transient";

// ---------------------------------------------------------------------------
// Who gets it
// ---------------------------------------------------------------------------

export const CARES = 0.5;

export interface Ranked {
  email: string;
  value: number;
  filter_p: number | null;
}

/** "cares" = everyone at or above the threshold; a number = the top N. People outside the "to:" filter never get it. */
export function pickRecipients(rows: Ranked[], mode: "cares" | number): string[] {
  const eligible = rows
    .filter((r) => r.filter_p === null || r.filter_p >= CARES)
    .sort((a, b) => b.value - a.value || (a.email < b.email ? -1 : 1));
  return (mode === "cares" ? eligible.filter((r) => r.value >= CARES) : eligible.slice(0, mode)).map((r) => r.email);
}

// ---------------------------------------------------------------------------
// The email itself
// ---------------------------------------------------------------------------

const NAME_VARS = /\{\{\s*(first_?name|name)\s*\}\}|\(\(\s*name\s*\)\)/gi;

export const firstName = (name: string | null) => (name ?? "").trim().split(/\s+/)[0] || "there";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain-looking personal email: text part + a minimal HTML part with clickable links. */
export function renderMail(body: string, name: string | null, unsubUrl: string): { text: string; html: string } {
  const filled = body.replace(NAME_VARS, firstName(name));
  const text = `${filled}\n\n—\nDon't want these emails? Unsubscribe: ${unsubUrl}`;
  const paras = filled
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${paras}
<p style="font-size:12px;color:#888;margin-top:32px">Don't want these emails? <a href="${esc(unsubUrl)}" style="color:#888">Unsubscribe</a></p></div>`;
  return { text, html };
}

/** Hour 0–23 in the owner's time zone. */
export const localHour = (d: Date, tz: string) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(d));

// ---------------------------------------------------------------------------
// Resend webhook signature (Svix) — https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
// ---------------------------------------------------------------------------

export async function verifySvix(secret: string, id: string, timestamp: string, body: string, signatureHeader: string, nowSec: number): Promise<boolean> {
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return signatureHeader.split(" ").some((part) => part.split(",")[1] === expected);
}
