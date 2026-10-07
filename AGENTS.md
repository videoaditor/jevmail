# AGENTS.md — set up JevMail for a business owner

You are an AI agent (Claude Code, Codex, Cursor, …). Someone gave you this repo, or a link to it, and
asked you to set it up. **This file is your full playbook.** Follow it top to bottom. Don't improvise
the order.

**What JevMail is.** It's a Telegram bot. The owner types an email into it. Jev reads every lead the
owner has and judges whether this email is worth something to that person. Jev is a decision model
from TypeSafe. The bot then answers with something like "37 of 1,200 people care about this", plus
buttons. One tap sends it to only those people, slowly and politely. The other 1,163 never hear about
it, so they stay subscribed and the owner's sender reputation stays clean.

**Who you're talking to.** A non-technical business owner. They don't know what a terminal, a
repo, an API or DNS is, and they shouldn't have to. Your target is **under 10 minutes of their
time**. Most of that time is spent waiting for their domain to verify.

---

## Rules for you, the agent

1. **You run every command.** Never ask the owner to open a terminal or paste a command.
2. **One step per message.** Every step starts with the **clickable link**, then **one bolded
   action**, then what they'll see when it worked. Nothing else.
3. **Show progress in every message**, for example "Step 4 of 8 — your Telegram bot".
4. **Multiple choice over open questions.** Use your ask-the-user tool if you have one (Claude Code:
   `AskUserQuestion`). Otherwise write numbered options like "reply 1, 2 or 3". Put the recommended
   option first.
5. **No jargon.** Use the words in the right column:

   | Don't say | Say |
   |---|---|
   | API key | key, a password for apps |
   | DNS records | settings at the place where you bought your domain |
   | deploy | put it online |
   | webhook | connection |
   | D1 / Worker | (don't mention them) |

6. **Secrets.** The owner pastes keys into the chat. Store each one immediately with
   `printf '%s' '<value>' | npx wrangler secret put <NAME>`. After that:
   - Never write a key into a file in this repo.
   - Never print a key back to the owner.
   - Never commit a key.

   Before Cloudflare login is done (step 4), keep keys in memory. Tell the owner they'll be stored
   safely in a minute.
7. **Check every step before you move on.** Each step below has a check. If the check fails,
   look up the cause in "When something goes wrong" below. Don't tell the owner "done" until the
   check has passed.
8. **Never send real email to the owner's leads during setup.** The only email you send is a test
   to the owner's own address.

### What you need

- **Node.js 22.6 or newer** (`node -v`). If it's missing or older, send the owner to
  https://nodejs.org/en/download and have them **click "macOS Installer" / "Windows Installer"** and
  click through. On a Mac with Homebrew you can run `brew install node` yourself.
- **This repo on disk.** If you only have the link, run
  `git clone https://github.com/videoaditor/jevmail ~/jevmail` and work in `~/jevmail`.
- Then run `npm install` in the repo.
- **Can't run commands?** (for example plain claude.ai chat): say so in one line. Tell the owner to
  open the Claude desktop app (https://claude.ai/download) → **Code** tab, and paste the repo link
  there.

---

## The setup — 8 steps

Before step 1, send this message as-is, then go straight into step 1:

> I'll set up JevMail for you. It takes about 10 minutes and you won't need any technical knowledge.
> I'll ask you a few quick questions, then walk you through 4 free accounts with one click each.

### Step 1 of 8 — Four quick questions

Ask **one question at a time**.

**Q1. "Where do your email leads live today?"** (multiple choice)

1. Klaviyo
2. Mailchimp
3. Shopify (customers / newsletter sign-ups)
4. HubSpot
5. A spreadsheet or a file export (Excel, Google Sheets, CSV)
6. Somewhere else (tell me the name)

Remember the answer for step 7. For "somewhere else", check whether that platform has an API that
can list contacts with their marketing consent:
- **It does:** treat it like Klaviyo (step 7, "Platform with an API").
- **It doesn't:** use CSV.

**Q2. "Where do people sign up?"** (free text)

> Paste the links to every page where people give you their email: landing pages, quizzes, popups,
> free guides, your shop. Just paste them all, one per line. No links? Describe them in a sentence
> each.

Then do the following yourself, without asking:
1. Open every link (WebFetch / curl).
2. For each page, write one line: what the page **promised** (discount, guide, quiz result…) and what
   it **asked** (quiz questions, fields).
3. Write these lines into `FUNNELS` in `src/business.ts`. The key of each line must equal the
   `source` name that this page's leads will carry. That's the list, form or segment name in their
   platform, or the CSV caption. If you don't know that name yet, use a short page name and fix it
   in step 7.
4. Write `BUSINESS` in `src/business.ts`: 2–4 sentences on what they sell, to whom, and what their
   emails are about, based on the pages.

Show the owner the result in plain words. Ask **"Is this right?"** with the options **1 Yes** and
**2 Let me correct it**.

**Q3. "What's your email address?"** (free text)

> Replies to your emails go there, and your test email lands there.

This value becomes `REPLY_TO`.

**Q4. "Who should the emails come from?"** (multiple choice). Fill in their real first name and
brand:

1. "Jane from Brand"
2. "Brand"
3. Something else

Then work out the domain yourself from Q2 and Q3, for example `yourbrand.com`. Recommend sending
from a **subdomain**: `FROM_EMAIL = "Jane from Brand <jane@mail.yourbrand.com>"`. If these emails ever
get spam complaints, only the subdomain's reputation suffers, not the domain they use for everyday
email. Confirm with one question: **1 Send from mail.yourbrand.com (recommended)**,
**2 Send from yourbrand.com**.

Find out the time zone yourself (`date +%Z`, or from the address on their website) and confirm it in
one line. Write it into `TIME_ZONE` as an IANA name, for example `America/New_York`.

**Check:** `src/business.ts` contains no "EXAMPLE" text, and every value you'll need in
`wrangler.jsonc` → `vars` is known, apart from `PUBLIC_URL`.

### Step 2 of 8 — Email sending account (Resend)

Do this one early: the domain check runs in the background while you do steps 3–6.

1. https://resend.com/signup → **Sign up** (Google login is fine).
2. https://resend.com/domains → **click "Add Domain"**.
   - Type the sending domain from Q4, for example `mail.yourbrand.com`.
   - For **Region**, pick the one closest to their customers.
   - Click **Add**.
3. They now see 3–4 settings (records) to copy. First, run
   `dig +short NS yourbrand.com` yourself to find out where their domain is managed. Then send the
   **one** matching link:

| Name server contains | Where the settings go |
|---|---|
| `cloudflare.com` | https://dash.cloudflare.com → domain → **DNS** → **Add record**. If Resend offers **"Sign in to Cloudflare"** / auto-configure, click it — done in one click. |
| `domaincontrol.com` | GoDaddy: https://dcc.godaddy.com/control/portfolio → domain → **DNS** → **Add New Record** |
| `registrar-servers.com` | Namecheap: https://ap.www.namecheap.com/domains/list → **Manage** → **Advanced DNS** → **Add new record** |
| `squarespacedns.com`, `googledomains.com` | Squarespace: https://account.squarespace.com/domains → domain → **DNS** → **Add record** |
| `wixdns.net` | Wix: https://manage.wix.com/account/domains → **⋯** → **Manage DNS records** |
| `shopify` / `myshopify` | Shopify: https://admin.shopify.com/settings/domains → domain → **Domain settings** → **Edit DNS settings** |
| `awsdns` | AWS Route 53: https://console.aws.amazon.com/route53/v2/hostedzones → domain → **Create record** |
| anything else | Search "<provider> add DNS record". Send the exact page link. |

   Walk them through it **one record at a time**. Tell them exactly what to type into "Type",
   "Name/Host" and "Value", and that "TTL" can stay as it is. Many providers add the domain to "Name"
   by themselves: for `send.mail.yourbrand.com` they type only `send.mail`. Ask for a screenshot if
   they get stuck.
4. Back on https://resend.com/domains → **click "Verify DNS Records"**. It can take a few minutes,
   so move on to step 3 and come back to it in step 6.

### Step 3 of 8 — The Telegram bot

1. Telegram on phone or desktop. Download it at https://telegram.org if they don't have it.
2. https://t.me/BotFather → **press Start**, then **send `/newbot`**.
3. BotFather asks for a name → **type the brand name**, for example "Brand Mail".
4. BotFather asks for a username → it must end in `bot`, for example `brandmail_bot`. If it's
   taken, try another.
5. BotFather replies with a long token like `123456:ABC-…` → **copy it and paste it here**.
6. Open the link BotFather gave them (`t.me/<username>`) → **press Start**. Tell them nothing will
   reply yet, and that's fine.

Then do the following yourself:
- Get the owner's chat id: `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"` →
  `result[].message.chat.id`. This only works **before** the connection is set up in step 5. If the
  result is empty, ask them to send "hi" to the bot and try again.
- Make a random secret for the connection: `openssl rand -hex 24`.

### Step 4 of 8 — Hosting (Cloudflare, free)

1. https://dash.cloudflare.com/sign-up → **create a free account**. Skip this if they already have
   one.
2. You run `npx wrangler login`. A browser tab opens → **click "Allow"**.
3. **Check:** `npx wrangler whoami` shows their account.

Keep the Telegram values in memory for now. Secrets can only be stored once the bot is online, in
step 5.

### Step 5 of 8 — You build it (the owner waits ~1 minute)

Tell the owner: "Building your bot now — about a minute."

1. Run `npx wrangler d1 create jevmail` and copy the `database_id` into `wrangler.jsonc`.
2. Run `npm run db:init`. This creates the tables. It's safe to run again.
3. Fill in every `SETUP:` value in `wrangler.jsonc` → `vars`. For `PUBLIC_URL`, put any
   placeholder for now.
4. Run `npm test`. It must pass.
5. Run `npm run deploy`.
   - The output shows the URL, `https://jevmail.<subdomain>.workers.dev`. Put that into
     `PUBLIC_URL` and run `npm run deploy` again.
   - If it asks to register a workers.dev subdomain, send them
     https://dash.cloudflare.com/?to=/:account/workers-and-pages → **open "Workers & Pages" once**.
     That creates the subdomain. Then deploy again.
6. Store the remaining secrets: `TELEGRAM_*` (if not done yet) and `TYPESAFE_API_KEY` once you have
   it from step 6. Use `printf '%s' '…' | npx wrangler secret put NAME`.
7. Connect Telegram:

   ```
   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=<PUBLIC_URL>/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]'
   ```

8. **Check:**
   - `curl <PUBLIC_URL>/` returns "JevMail is running."
   - `getWebhookInfo` shows the URL and no `last_error_message`.
   - The owner sends `/start` to the bot and gets the help text back.

### Step 6 of 8 — Two keys: TypeSafe and Resend

**TypeSafe** (the AI that decides who cares):
1. https://console.typesafe.ai/keys → **log in or sign up**.
2. **Click "Create key"** (it may be called "New API key").
3. **Copy it and paste it here.**

You store it as `TYPESAFE_API_KEY`.

**Resend** (sends the emails):
1. https://resend.com/domains. The domain must say **Verified**. If it doesn't yet, see
   "When something goes wrong".
2. https://resend.com/api-keys → **click "Create API Key"**.
   - Name: `JevMail`.
   - Permission: **Sending access**.
   - Domain: **their domain**.
   - Click **Add**.
3. **Copy the key and paste it here.**

You store it as `RESEND_API_KEY`.

**Bounces and spam complaints** (protects their reputation, 30 seconds):
1. https://resend.com/webhooks → **click "Add Webhook"**.
2. Endpoint URL: `<PUBLIC_URL>/resend`.
3. Events: **email.bounced** and **email.complained**.
4. Click **Add**.
5. Open the new webhook → **copy the "Signing Secret" and paste it here**.

You store it as `RESEND_WEBHOOK_SECRET`.

**Check:** the TypeSafe key works:

```
curl -s https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"model":"jev-latest","state":"test","questions":{"q":{"type":"noul","instructions":"Is this a test?"}}}'
```

The response must contain `"noul"`.

### Step 7 of 8 — Bring in the leads

The path depends on Q1.

**CSV / spreadsheet / Shopify** (the easiest path, no key needed). Send the matching link and one
action:

| Where | Steps |
|---|---|
| Shopify | https://admin.shopify.com/customers → **filter "Email subscription" = Subscribed** → **Export** → "All customers matching search" → CSV. The file comes by email. |
| Google Sheets | **File → Download → Comma-separated values (.csv)** |
| Excel | **File → Save As → CSV UTF-8** |
| Klaviyo (no API) | https://www.klaviyo.com/lists → list → **Manage list → Export list to CSV** |
| Mailchimp (no API) | https://admin.mailchimp.com/audience/contacts → **Export Audience** |

Then: **"Send the file to your bot. In the caption, write where these people signed up"**, for
example "Spring quiz". The caption becomes the `source`, so it should match a key in `FUNNELS`.

- One file per sign-up page is best.
- The bot reads any columns. It finds the email and first-name columns itself.
- Rows marked as not consenting to marketing become "unsubscribed".
- If they have a single file mixing several sign-up pages, that's fine. Every lead gets `default`.

**Platform with an API** (Klaviyo, Mailchimp, HubSpot, other). Leads sync every hour on their own.
1. Send the key link below.
2. You store the key as a secret.
3. You implement `pullLeads` in `src/source.ts`, following the contract in that file. Read the
   platform's current API docs first; menus and endpoints change.
4. Use the platform's list or form names as `source`, and line up the `FUNNELS` keys with them.

| Platform | Key — what the owner clicks | What you build |
|---|---|---|
| Klaviyo | https://www.klaviyo.com/settings/account/api-keys → **Create Private API Key** → name `JevMail` → **Read-only key** → **Create** → copy (starts with `pk_`) | `GET https://a.klaviyo.com/api/profiles?additional-fields[profile]=subscriptions&page[size]=100`, headers `Authorization: Klaviyo-API-Key <key>`, `revision: <current date-version from their docs>`. Follow `links.next`. Consent = `subscriptions.email.marketing.consent == "SUBSCRIBED"`. Source = list name: one call to `/api/lists`, then `/api/lists/{id}/profiles` per list. Facts = `properties` + `location.country`. Secret: `KLAVIYO_API_KEY`. |
| Mailchimp | https://admin.mailchimp.com/account/api/ → **Create A Key** → name `JevMail` → **Generate Key** → copy (ends in `-us21` or similar = data center) | Basic auth `anystring:<key>`, base `https://<dc>.api.mailchimp.com/3.0`. `GET /lists`, then `GET /lists/{id}/members?count=1000&offset=…`. Consent = `status == "subscribed"`. Source = list name, or `tags` if they use one list. Facts = `merge_fields` (without email/name), `tags`, `location.country_code`. Secret: `MAILCHIMP_API_KEY`. |
| HubSpot | https://app.hubspot.com → ⚙ Settings → **Integrations → Private Apps** (newer accounts: **Development → Legacy apps**) → **Create** → Scopes: `crm.objects.contacts.read` → **Create app** → copy the access token | `GET https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=email,firstname,hs_marketable_status,lifecyclestage,country,hs_analytics_source,recent_conversion_event_name&after=…`, Bearer token. Consent = `hs_marketable_status == "true"`. Source = `recent_conversion_event_name`, else `hs_analytics_source`. Secret: `HUBSPOT_TOKEN`. |
| Other | Find the "API keys" page in their settings. Send that exact link. Pick **read-only** if offered. | Same contract. Paginate, map consent, never guess consent: no consent field means `unsubscribed: true`. |

Run `npm run deploy`. Then the owner **sends `/sync` to the bot**: the first sync runs right away,
and after that it runs every hour by itself.

**Check:** `/leads` in the bot shows the expected number of leads, with sources that match `FUNNELS`.
If the sources don't match, fix the keys in `FUNNELS` and run `npm run deploy`.

### Step 8 of 8 — The first email (the "it works" moment)

Send the owner this, written out in a code block so they can copy it:

```
New here? Here's what we do
Hi {{name}},

(write two lines about something you actually want to tell your leads)
```

Then:
1. **"Send that to your bot."** Within a minute or two it answers with how many people care, plus
   buttons.
2. **"Tap 'Send me a test'."** The test arrives in their inbox, from their name, with an
   unsubscribe link.
3. Tell them they can now **cancel**, or **send it for real** if it's a real email.

Then give them this short guide and you're done:

> **How to use JevMail**
> - Type an email to your bot. First line = subject, then the text. Use `{{name}}` for the first name.
> - Only for some people? Start with a line like `to: people who bought the starter kit`.
> - The bot tells you how many people care. Tap **Send to the N who care**. It goes out slowly,
>   between 8:00 and 20:00. Nobody gets two emails within 48 hours.
> - New leads: send a CSV to the bot. If your platform is connected, new leads sync every hour
>   (`/sync` does it right away).
> - `/leads` shows how many people you can email.

---

## How it works (for you, the agent)

```
Owner ──Telegram──▶ Worker /telegram ──▶ D1 broadcasts (status: ranking)
                                    cron every minute:
                      1. send: ≤ SENDS_PER_MINUTE queued deliveries ──▶ Resend
                      2. rank: ≤ RANK_PER_MINUTE leads ──▶ Jev (TypeSafe) ──▶ D1 rankings
                         all ranked ──▶ card to owner: "N care" + buttons
                      3. at :00 ──▶ pullLeads() (src/source.ts) ──▶ D1 leads
Owner taps Send ──▶ D1 deliveries (queued) ──▶ step 1 drains them
Lead clicks unsubscribe ──▶ /u/<id> (GET shows a button, POST unsubscribes; one-click mail header POSTs)
Resend bounce/complaint ──▶ /resend (signature checked) ──▶ lead unsubscribed
Forms / Zapier / Make ──▶ POST /leads (Bearer INGEST_KEY) ──▶ D1 leads
```

| File | What it is |
|---|---|
| `src/index.ts` | The Worker: routes, Telegram bot, ranking loop, sending loop |
| `src/logic.ts` | Pure logic: parsing, CSV, Jev request/answer, who gets it, email rendering. Tested. |
| `src/business.ts` | `BUSINESS` + `FUNNELS`. **You fill this in during setup.** |
| `src/source.ts` | `pullLeads()`. **You write this** if the owner has a platform with an API. |
| `schema.sql` | Database tables. Safe to re-run. |
| `wrangler.jsonc` | Settings (`vars`) and the database id |

**How Jev decides.** There's one request per lead. Jev sees:
- the email (subject and body),
- `BUSINESS`,
- where the person signed up and what that page offered,
- the facts we know about them.

Contact details are stripped, because Jev ranks people and doesn't need to know who they are. Jev
answers two questions:
- a 4-level **Score** for "how much value does this person get from this email",
- a **Noul** (yes/no probability) for the `to:` line, if there is one.

`value ≥ 0.5` means the person cares. A `to:` line is a hard gate: `filter_p ≥ 0.5`. API docs:
https://docs.typesafe.ai/api.md.

**Settings** (`wrangler.jsonc` → `vars`; redeploy after changing):

| Var | Default | Meaning |
|---|---|---|
| `SENDS_PER_MINUTE` | 1 | Pace. Slow is good for a new domain. Raise it to 2–5 after a few weeks without problems. |
| `DAILY_CAP` | 100 | The Resend free plan allows 100/day and 3,000/month. On a paid Resend plan, raise it. |
| `GAP_HOURS` | 48 | Nobody gets two emails closer together than this. Waiting emails go out later; they're not dropped. |
| `SEND_START_HOUR` / `SEND_END_HOUR` | 8 / 20 | Sending window, in `TIME_ZONE` |
| `RANK_PER_MINUTE` | 40 | The Cloudflare free plan allows 50 outgoing calls per run. On Workers Paid ($5/mo), 500 is fine. |

**Optional: real-time leads from forms.**
1. Set `INGEST_KEY` (`openssl rand -hex 24`, then `wrangler secret put`).
2. Point any form tool, Zapier or Make at `POST <PUBLIC_URL>/leads` with header
   `Authorization: Bearer <INGEST_KEY>`.
3. The JSON body looks like this:

   ```json
   {"email": "...", "name": "...", "source": "Spring quiz", "any_other_field": "..."}
   ```

   You can also send an array of these.

## When something goes wrong

| Symptom | Cause | What you do |
|---|---|---|
| Resend domain stays "Pending" | The settings are wrong or haven't spread yet | Compare each record with `dig TXT <name>` / `dig MX <name>`. Most common: the domain was typed twice into "Name". Wait up to 30 min, then click **Verify** again. |
| Bot says "Sending paused — Resend refused" | The domain isn't verified, or the key is wrong or has no access to the domain | Fix it in Resend. The owner taps **Resume**. Nothing was lost. |
| Bot says "I couldn't check … 401" | Wrong TypeSafe key | Store it again with `wrangler secret put TYPESAFE_API_KEY`. The owner sends the email again. |
| Bot never answers | The connection to Telegram is broken | `getWebhookInfo` → check `url` and `last_error_message`. Check the secret token matches. Check `TELEGRAM_CHAT_ID` is the owner's chat (the bot stays silent for everyone else on purpose). |
| Ranking is slow | Free plan: 40 leads per minute | 2,000 leads take about 50 minutes. Fine — the bot pings when it's done. To speed it up: Workers Paid + `RANK_PER_MINUTE` 500. |
| Rate limit from TypeSafe (429) | Too many calls | Nothing to do. The run stops and continues the next minute by itself. |
| `wrangler` errors about Node | Node too old | Install Node 22 or newer (see "What you need"). |
| Hourly sync shows nothing | `pullLeads` threw an error | `npm run logs`, then wait for minute :00. Fix it and redeploy. Existing leads are never deleted. |

Everything else: `npm run logs` shows live logs. Rule of thumb: **not sending is always safer than
sending wrong.** If you're unsure, leave it queued and ask the owner.
