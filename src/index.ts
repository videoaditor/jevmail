// JevMail — a Telegram bot that sends each email only to the leads who care about it.
// One Cloudflare Worker: Telegram webhook in, Jev (TypeSafe) ranks every lead, Resend sends, D1 remembers.
// Runs every minute (wrangler.jsonc → triggers): rank a batch, send a few, sync leads once an hour.

import { BUSINESS, FUNNELS } from "./business.ts";
import { pullLeads } from "./source.ts";
import {
  JEV_URL,
  buildJevRequest,
  csvToLeads,
  jevErrorKind,
  localHour,
  normEmail,
  parseCsv,
  parseJev,
  parseMail,
  personState,
  pickRecipients,
  renderMail,
  verifySvix,
  CARES,
  type Lead,
  type Ranked,
} from "./logic.ts";

interface Env {
  DB: D1Database;
  // secrets (npx wrangler secret put NAME)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TYPESAFE_API_KEY: string;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET?: string;
  INGEST_KEY?: string;
  // vars (wrangler.jsonc)
  PUBLIC_URL: string;
  FROM_EMAIL: string;
  REPLY_TO: string;
  TIME_ZONE: string;
  SEND_START_HOUR: string;
  SEND_END_HOUR: string;
  SENDS_PER_MINUTE: string;
  DAILY_CAP: string;
  GAP_HOURS: string;
  RANK_PER_MINUTE: string;
}

const now = () => new Date().toISOString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const int = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== "" && v !== undefined ? Number(v) : d);
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function tg(env: Env, method: string, payload: object): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!json.ok) console.log(`telegram ${method} failed: ${res.status} ${json.description ?? ""}`);
  return json.result;
}

const say = (env: Env, chatId: number | string, text: string, buttons?: { text: string; callback_data: string }[][]) =>
  tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });

const HELP = `<b>JevMail</b> sends each email only to the people who care about it.

<b>Send an email:</b> just type it here.
First line = subject. Everything below = the email.
Write <code>{{name}}</code> where the first name should go.

<b>Only for some people?</b> Start with a line like
<code>to: people who asked about wholesale</code>

<b>Add leads:</b> send me a .csv file (any export with an email column). The caption becomes their source, e.g. "Spring quiz".

/leads — how many leads you have
/sync — pull new leads from your lead platform now (otherwise hourly)`;

async function onTelegram(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  const update: any = await req.json();
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok"); // private bot: strangers get silence
  try {
    if (update.callback_query) await onButton(env, update.callback_query, ctx);
    else if (update.message?.document) await onCsv(env, update.message);
    else if (typeof update.message?.text === "string") await onText(env, update.message.text, chatId, ctx);
  } catch (e) {
    console.log("telegram handler error", e);
    await say(env, chatId, `Something went wrong on my side: ${esc(String(e)).slice(0, 300)}\nNothing was sent.`);
  }
  return new Response("ok"); // always 200, or Telegram retries the same update forever
}

async function onText(env: Env, text: string, chatId: number, ctx: ExecutionContext) {
  const cmd = text.trim().toLowerCase();
  if (cmd === "/start" || cmd === "/help") return say(env, chatId, HELP);
  if (cmd === "/leads") return say(env, chatId, await leadStats(env));
  if (cmd === "/sync") {
    const leads = await pullLeads(env as unknown as Record<string, unknown>);
    if (!leads.length) return say(env, chatId, "No lead platform is connected (or it returned nobody). Send me a .csv instead.");
    return say(env, chatId, `Synced ${leads.length} leads (${await upsertLeads(env, leads)} new).`);
  }
  if (cmd.startsWith("/")) return say(env, chatId, "I don't know that command.\n\n" + HELP);

  const mail = parseMail(text);
  if (!mail.ok) return say(env, chatId, mail.error);
  const pool = await env.DB.prepare("SELECT count(*) AS n FROM leads WHERE unsubscribed_at IS NULL").first<{ n: number }>();
  if (!pool?.n) return say(env, chatId, "You don't have any leads yet. Send me a .csv file with your leads first.");
  const id = newId();
  await env.DB.prepare("INSERT INTO broadcasts (id, subject, body, filter, status, chat_id, created_at) VALUES (?, ?, ?, ?, 'ranking', ?, ?)")
    .bind(id, mail.subject, mail.body, mail.filter, chatId, now())
    .run();
  const minutes = Math.ceil(pool.n / int(env.RANK_PER_MINUTE, 40));
  await say(
    env,
    chatId,
    `Got it: <b>${esc(mail.subject)}</b>${mail.filter ? `\nOnly for: <i>${esc(mail.filter)}</i>` : ""}\n\nChecking who cares about this among ${pool.n} people — ${minutes <= 1 ? "about a minute" : `about ${minutes} minutes`}. I'll message you, nothing is sent yet.`,
  );
  ctx.waitUntil(rankTick(env, 25_000));
}

async function leadStats(env: Env): Promise<string> {
  const t = await env.DB.prepare(
    "SELECT count(*) AS total, sum(unsubscribed_at IS NULL) AS mailable FROM leads",
  ).first<{ total: number; mailable: number }>();
  const bySource = await env.DB.prepare(
    "SELECT coalesce(source, '(none)') AS s, count(*) AS n FROM leads WHERE unsubscribed_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
  ).all<{ s: string; n: number }>();
  const lines = bySource.results.map((r) => `• ${esc(r.s)}: ${r.n}`).join("\n");
  return `<b>${t?.mailable ?? 0}</b> leads you can email (${(t?.total ?? 0) - (t?.mailable ?? 0)} unsubscribed).\n${lines}`;
}

async function onCsv(env: Env, msg: any) {
  const doc = msg.document;
  if (!/\.csv$/i.test(doc.file_name ?? "")) return say(env, msg.chat.id, "Please send a .csv file. In Excel or Google Sheets: File → Download → CSV.");
  const file = await tg(env, "getFile", { file_id: doc.file_id });
  if (!file?.file_path) return say(env, msg.chat.id, "Telegram didn't give me the file (files over 20 MB don't work). Try a smaller export.");
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  const source = (msg.caption ?? "").trim() || doc.file_name.replace(/\.csv$/i, "");
  const { leads, noEmail, noConsent } = csvToLeads(parseCsv(await res.text()), source);
  if (!leads.length) return say(env, msg.chat.id, `I found no email addresses in that file (${noEmail} rows without one). Does it have a column called "Email"?`);
  const added = await upsertLeads(env, leads);
  await say(
    env,
    msg.chat.id,
    `Imported <b>${leads.length}</b> leads from "${esc(source)}" (${added} new).` +
      (noConsent ? `\n${noConsent} marked unsubscribed — the file says they didn't agree to marketing email.` : "") +
      (noEmail ? `\n${noEmail} rows skipped — no valid email.` : ""),
  );
}

async function onButton(env: Env, q: any, ctx: ExecutionContext) {
  const [action, id, arg] = String(q.data).split(":");
  const chatId = q.message.chat.id;
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const b = await env.DB.prepare("SELECT * FROM broadcasts WHERE id = ?").bind(id).first<any>();
  if (!b) return;
  const dropButtons = () => tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });

  if (action === "test") {
    const r = await sendOne(env, { to: env.REPLY_TO, subject: `[TEST] ${b.subject}`, body: b.body, name: null, deliveryId: "test" });
    return say(env, chatId, r.ok ? `Test sent to ${esc(env.REPLY_TO)}. Check your inbox (and the spam folder).` : `Test failed: ${esc(r.error)}`);
  }
  if (action === "cancel") {
    await env.DB.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status IN ('ranking', 'ready', 'sending', 'stuck')").bind(id).run();
    await dropButtons();
    return say(env, chatId, `Stopped “${esc(b.subject)}”. Nothing more goes out.`);
  }
  if (action === "resume") {
    await env.DB.prepare("UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'stuck'").bind(id).run();
    await dropButtons();
    return say(env, chatId, "Resumed. I'll keep sending.");
  }
  if (action === "send") {
    if (b.status !== "ready") return say(env, chatId, `This email is already ${b.status}.`);
    const rows = await env.DB.prepare("SELECT email, value, filter_p FROM rankings WHERE broadcast_id = ?").bind(id).all<Ranked>();
    const picked = pickRecipients(rows.results, arg === "cares" ? "cares" : int(arg, 100));
    if (!picked.length) return say(env, chatId, "Nobody to send to.");
    const claimed = await env.DB.prepare("UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'ready'").bind(id).run();
    if (!claimed.meta.changes) return; // double tap
    for (let i = 0; i < picked.length; i += 500)
      await env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries (id, broadcast_id, email) SELECT lower(hex(randomblob(8))), ?1, value FROM json_each(?2)",
      )
        .bind(id, JSON.stringify(picked.slice(i, i + 500)))
        .run();
    await dropButtons();
    const perDay = Math.min(int(env.DAILY_CAP, 100), int(env.SENDS_PER_MINUTE, 1) * 60 * (int(env.SEND_END_HOUR, 20) - int(env.SEND_START_HOUR, 8)));
    await say(
      env,
      chatId,
      `Sending to <b>${picked.length}</b> people, up to ${perDay} a day between ${env.SEND_START_HOUR}:00 and ${env.SEND_END_HOUR}:00 (${esc(env.TIME_ZONE)}). Nobody gets two emails within ${env.GAP_HOURS} hours. I'll tell you when it's done.`,
      [[{ text: "Stop sending", callback_data: `cancel:${id}` }]],
    );
  }
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/** Insert or merge. Never clears an unsubscribe. Returns how many were new. */
async function upsertLeads(env: Env, leads: Lead[]): Promise<number> {
  const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM leads").first<{ n: number }>())?.n ?? 0;
  const before = await count();
  const at = now();
  for (let i = 0; i < leads.length; i += 200) {
    const chunk = leads.slice(i, i + 200).map((l) => ({ ...l, facts: l.facts ?? {}, unsubscribed: l.unsubscribed ? 1 : 0 }));
    await env.DB.prepare(
      `INSERT INTO leads (email, name, source, facts, added_at, unsubscribed_at, unsub_reason)
       SELECT json_extract(value, '$.email'), json_extract(value, '$.name'), json_extract(value, '$.source'),
              json(json_extract(value, '$.facts')), ?2,
              CASE WHEN json_extract(value, '$.unsubscribed') = 1 THEN ?2 END,
              CASE WHEN json_extract(value, '$.unsubscribed') = 1 THEN 'source' END
       FROM json_each(?1) WHERE true
       ON CONFLICT (email) DO UPDATE SET
         name = coalesce(excluded.name, leads.name),
         source = coalesce(leads.source, excluded.source),
         facts = json_patch(leads.facts, excluded.facts),
         unsubscribed_at = coalesce(leads.unsubscribed_at, excluded.unsubscribed_at),
         unsub_reason = coalesce(leads.unsub_reason, excluded.unsub_reason)`,
    )
      .bind(JSON.stringify(chunk), at)
      .run();
  }
  return (await count()) - before;
}

/** POST /leads — for forms, Zapier, Make, webhooks. Body: one lead or an array of leads. */
async function onIngest(req: Request, env: Env): Promise<Response> {
  if (!env.INGEST_KEY || req.headers.get("authorization") !== `Bearer ${env.INGEST_KEY}`) return new Response("unauthorized", { status: 401 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "body must be JSON" }, { status: 400 });
  }
  const leads: Lead[] = [];
  for (const raw of Array.isArray(body) ? body : [body]) {
    const { email, name, source, unsubscribed, ...facts } = raw ?? {};
    const e = normEmail(email);
    if (!e) continue;
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(facts)) if (v !== null && v !== undefined && v !== "") f[k] = typeof v === "string" ? v : JSON.stringify(v);
    leads.push({ email: e, name: name ? String(name) : null, source: source ? String(source) : null, facts: f, unsubscribed: !!unsubscribed });
  }
  if (!leads.length) return Response.json({ ok: false, error: "no valid email" }, { status: 400 });
  const added = await upsertLeads(env, leads);
  return Response.json({ ok: true, received: leads.length, added });
}

// ---------------------------------------------------------------------------
// Ranking: Jev reads every lead against the email
// ---------------------------------------------------------------------------

async function rankTick(env: Env, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  const b = await env.DB.prepare("SELECT * FROM broadcasts WHERE status = 'ranking' ORDER BY created_at LIMIT 1").first<any>();
  if (!b) return;
  const todo = await env.DB.prepare(
    `SELECT l.email, l.source, l.facts FROM leads l
     WHERE l.unsubscribed_at IS NULL AND NOT EXISTS (SELECT 1 FROM rankings r WHERE r.broadcast_id = ?1 AND r.email = l.email)
     LIMIT ?2`,
  )
    .bind(b.id, int(env.RANK_PER_MINUTE, 40))
    .all<{ email: string; source: string | null; facts: string }>();

  if (!todo.results.length) return finishRanking(env, b);

  const results: Ranked[] = [];
  let stop: string | null = null;
  const queue = [...todo.results];
  const worker = async () => {
    // ponytail: 6 parallel calls = Cloudflare's open-connection limit per invocation
    while (queue.length && !stop && Date.now() < deadline) {
      const lead = queue.shift()!;
      const req = buildJevRequest(b, personState(lead, FUNNELS), BUSINESS, b.filter);
      let res: Response;
      try {
        res = await fetch(JEV_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        continue; // network/timeout: this person is retried next minute
      }
      if (!res.ok) {
        const kind = jevErrorKind(res.status);
        const detail = await res.text().catch(() => "");
        if (kind === "rate_limited") stop = "rate_limited";
        else if (kind === "bad_request") stop = `TypeSafe said ${res.status}: ${detail.slice(0, 200)}`;
        continue;
      }
      const parsed = parseJev(await res.json().catch(() => null), !!b.filter);
      if (parsed) results.push({ email: lead.email, ...parsed });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  if (results.length)
    await env.DB.prepare(
      `INSERT OR REPLACE INTO rankings (broadcast_id, email, value, filter_p)
       SELECT ?1, json_extract(value, '$.email'), json_extract(value, '$.value'), json_extract(value, '$.filter_p') FROM json_each(?2)`,
    )
      .bind(b.id, JSON.stringify(results))
      .run();

  if (stop && stop !== "rate_limited") {
    const r = await env.DB.prepare("UPDATE broadcasts SET status = 'failed' WHERE id = ? AND status = 'ranking'").bind(b.id).run();
    if (r.meta.changes)
      await say(env, b.chat_id, `I couldn't check “${esc(b.subject)}” — ${esc(stop)}.\nIf it says 401, the TypeSafe key is wrong. Nothing was sent.`);
  }
}

async function finishRanking(env: Env, b: any) {
  const claimed = await env.DB.prepare("UPDATE broadcasts SET status = 'ready' WHERE id = ? AND status = 'ranking'").bind(b.id).run();
  if (!claimed.meta.changes) return; // another run already finished it
  const rows = (await env.DB.prepare("SELECT email, value, filter_p FROM rankings WHERE broadcast_id = ?").bind(b.id).all<Ranked>()).results;
  const cares = pickRecipients(rows, "cares").length;
  const eligible = pickRecipients(rows, Infinity).length;
  const buttons: { text: string; callback_data: string }[][] = [];
  if (cares) buttons.push([{ text: `✅ Send to the ${cares} who care`, callback_data: `send:${b.id}:cares` }]);
  for (const n of [100, 300]) if (eligible > cares && n > cares && n < eligible) buttons.push([{ text: `Top ${n}`, callback_data: `send:${b.id}:${n}` }]);
  if (eligible > cares && eligible <= 300) buttons.push([{ text: b.filter ? `All ${eligible} who match` : `Everyone (${eligible})`, callback_data: `send:${b.id}:${eligible}` }]);
  buttons.push([
    { text: "Send me a test", callback_data: `test:${b.id}` },
    { text: "Cancel", callback_data: `cancel:${b.id}` },
  ]);
  await say(
    env,
    b.chat_id,
    `📬 <b>${esc(b.subject)}</b>\n\n<b>${cares}</b> of ${rows.length} people really care about this${b.filter ? ` (and ${eligible} match “${esc(b.filter)}”)` : ""}.` +
      (cares ? "" : `\nNobody is a strong match (score ≥ ${CARES}). You can still send to the best ones.`),
    buttons,
  );
}

// ---------------------------------------------------------------------------
// Sending: slow and steady protects the sender reputation
// ---------------------------------------------------------------------------

async function sendOne(env: Env, m: { to: string; subject: string; body: string; name: string | null; deliveryId: string }) {
  const unsub = `${env.PUBLIC_URL.replace(/\/$/, "")}/u/${m.deliveryId}`;
  const { text, html } = renderMail(m.body, m.name, unsub);
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `jevmail-${m.deliveryId}-${m.to}` },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [m.to],
        reply_to: env.REPLY_TO,
        subject: m.subject,
        text,
        html,
        headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    });
  } catch (e) {
    return { ok: false as const, kind: "transient" as const, error: String(e) };
  }
  if (res.ok) return { ok: true as const };
  const error = `${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`;
  // 401/403 = key or domain problem (affects every send) · 400/422 = this address · 429/5xx = later
  const kind = res.status === 401 || res.status === 403 ? "account" : res.status === 429 || res.status >= 500 ? "transient" : "address";
  return { ok: false as const, kind, error };
}

async function sendTick(env: Env) {
  const h = localHour(new Date(), env.TIME_ZONE || "UTC");
  if (h < int(env.SEND_START_HOUR, 8) || h >= int(env.SEND_END_HOUR, 20)) return;

  // people who unsubscribed while queued never get it
  await env.DB.prepare(
    "UPDATE deliveries SET status = 'failed', error = 'unsubscribed' WHERE status = 'queued' AND email IN (SELECT email FROM leads WHERE unsubscribed_at IS NOT NULL)",
  ).run();

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const sentToday = (await env.DB.prepare("SELECT count(*) AS n FROM deliveries WHERE sent_at > ?").bind(dayAgo).first<{ n: number }>())?.n ?? 0;
  const n = Math.min(int(env.SENDS_PER_MINUTE, 1), int(env.DAILY_CAP, 100) - sentToday);
  if (n > 0) {
    const gapCutoff = new Date(Date.now() - int(env.GAP_HOURS, 48) * 3_600_000).toISOString();
    const due = await env.DB.prepare(
      `SELECT d.id, d.email, d.broadcast_id, b.subject, b.body, b.chat_id, l.name FROM deliveries d
       JOIN broadcasts b ON b.id = d.broadcast_id AND b.status = 'sending'
       JOIN leads l ON l.email = d.email
       WHERE d.status = 'queued' AND (l.last_sent_at IS NULL OR l.last_sent_at < ?1)
       ORDER BY b.created_at, d.rowid LIMIT ?2`,
    )
      .bind(gapCutoff, n)
      .all<any>();

    for (const d of due.results) {
      // claim before sending: a crash means "not sent", never "sent twice"
      const at = now();
      const claim = await env.DB.prepare("UPDATE deliveries SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'queued'").bind(at, d.id).run();
      if (!claim.meta.changes) continue;
      const r = await sendOne(env, { to: d.email, subject: d.subject, body: d.body, name: d.name, deliveryId: d.id });
      if (r.ok) {
        await env.DB.prepare("UPDATE leads SET last_sent_at = ? WHERE email = ?").bind(at, d.email).run();
        continue;
      }
      if (r.kind === "address") {
        await env.DB.prepare("UPDATE deliveries SET status = 'failed', sent_at = NULL, error = ? WHERE id = ?").bind(r.error, d.id).run();
        continue;
      }
      await env.DB.prepare("UPDATE deliveries SET status = 'queued', sent_at = NULL WHERE id = ?").bind(d.id).run();
      if (r.kind === "account") {
        const s = await env.DB.prepare("UPDATE broadcasts SET status = 'stuck' WHERE id = ? AND status = 'sending'").bind(d.broadcast_id).run();
        if (s.meta.changes)
          await say(env, d.chat_id, `Sending paused — Resend refused: <code>${esc(r.error)}</code>\nUsually the domain isn't verified yet or the API key is wrong. Fix it, then tap Resume.`, [
            [{ text: "Resume", callback_data: `resume:${d.broadcast_id}` }],
          ]);
      }
      break; // account or transient problem: stop this minute
    }
  }

  const done = await env.DB.prepare(
    `UPDATE broadcasts SET status = 'done' WHERE status = 'sending'
     AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.broadcast_id = broadcasts.id AND d.status = 'queued')
     RETURNING id, chat_id, subject`,
  ).all<any>();
  for (const b of done.results) {
    const c = await env.DB.prepare("SELECT sum(status = 'sent') AS sent, sum(status = 'failed') AS failed FROM deliveries WHERE broadcast_id = ?")
      .bind(b.id)
      .first<{ sent: number; failed: number }>();
    await say(env, b.chat_id, `✅ Done: <b>${esc(b.subject)}</b> went to ${c?.sent ?? 0} people.${c?.failed ? ` ${c.failed} skipped (unsubscribed or bad address).` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Unsubscribe + bounces
// ---------------------------------------------------------------------------

const page = (msg: string, form = "") =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title>
<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center;color:#111">
<p style="font-size:18px">${msg}</p>${form}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function onUnsubscribe(req: Request, env: Env, id: string): Promise<Response> {
  // GET only shows a button: link scanners in company inboxes open every link and must not unsubscribe people
  if (req.method === "GET")
    return page(
      "Unsubscribe from these emails?",
      `<form method="post"><button style="font-size:16px;padding:12px 24px;border-radius:10px;border:0;background:#111;color:#fff;cursor:pointer">Unsubscribe</button></form>`,
    );
  const d = await env.DB.prepare("SELECT email FROM deliveries WHERE id = ?").bind(id).first<{ email: string }>();
  if (d) await env.DB.prepare("UPDATE leads SET unsubscribed_at = coalesce(unsubscribed_at, ?), unsub_reason = coalesce(unsub_reason, 'link') WHERE email = ?").bind(now(), d.email).run();
  return page("You're unsubscribed. You won't get these emails anymore.");
}

/** Resend webhook: hard bounces and spam complaints are never mailed again. */
async function onResendWebhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const ok = await verifySvix(
    env.RESEND_WEBHOOK_SECRET ?? "",
    req.headers.get("svix-id") ?? "",
    req.headers.get("svix-timestamp") ?? "",
    body,
    req.headers.get("svix-signature") ?? "",
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return new Response("bad signature", { status: 401 });
  const ev = JSON.parse(body);
  const reason = ev.type === "email.complained" ? "complained" : ev.type === "email.bounced" && !/transient|temporary/i.test(ev.data?.bounce?.type ?? "") ? "bounced" : null;
  if (reason)
    for (const to of ev.data?.to ?? []) {
      const e = normEmail(to);
      if (e) await env.DB.prepare("UPDATE leads SET unsubscribed_at = coalesce(unsubscribed_at, ?), unsub_reason = coalesce(unsub_reason, ?) WHERE email = ?").bind(now(), reason, e).run();
    }
  return new Response("ok");
}

// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/telegram") return onTelegram(req, env, ctx);
    if (req.method === "POST" && url.pathname === "/leads") return onIngest(req, env);
    if (req.method === "POST" && url.pathname === "/resend") return onResendWebhook(req, env);
    const u = url.pathname.match(/^\/u\/([a-z0-9]+)$/);
    if (u && (req.method === "GET" || req.method === "POST")) return onUnsubscribe(req, env, u[1]);
    if (url.pathname === "/") return new Response("JevMail is running.");
    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await sendTick(env).catch((e) => console.log("send error", e));
    await rankTick(env, 45_000).catch((e) => console.log("rank error", e));
    if (new Date(event.scheduledTime).getUTCMinutes() === 0)
      ctx.waitUntil(
        pullLeads(env as unknown as Record<string, unknown>)
          .then((leads) => (leads.length ? upsertLeads(env, leads) : 0))
          .then((added) => added && console.log(`lead sync: ${added} new`))
          .catch((e) => console.log("lead sync failed (retries next hour)", e)),
      );
  },
};
