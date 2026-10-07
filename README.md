# JevMail

**Email only the people who care.**

JevMail is a Telegram bot for your email list. You type an email into Telegram, and JevMail reads
every lead you have and decides who would actually want it. It replies with something like:

> 📬 **New wholesale pricing**
> **37** of 1,204 people really care about this.
> [ ✅ Send to the 37 who care ] [ Top 100 ] [ Send me a test ] [ Cancel ]

You tap once, and the email goes out slowly and politely, only to those 37. The other 1,167 never
see it. They stay subscribed, your emails stop landing in spam, and your list keeps getting better
instead of tired.

The decision for each lead is made by **[Jev](https://typesafe.ai)**, a decision model from
TypeSafe. It looks at the page where the person signed up, what that page offered them, and what
they told you, such as quiz answers, tags or plan.

## Set it up in about 10 minutes, no tech skills needed

1. Open **Claude Code**: the [Claude desktop app](https://claude.ai/download) → **Code** tab.
2. Paste this and press Enter:

   ```
   Set up JevMail for me: https://github.com/videoaditor/jevmail
   ```

3. Answer a few multiple-choice questions and click the links it gives you.

Claude asks where your leads are stored (Klaviyo, Mailchimp, Shopify, HubSpot, a spreadsheet…).
It scans your sign-up pages and walks you through four free accounts, one click at a time:

| What | Why | Cost |
|---|---|---|
| Telegram bot | Where you type your emails | Free |
| Cloudflare | Runs the bot | Free |
| Resend | Sends the emails from your domain | Free up to 100/day |
| TypeSafe | Jev decides who cares | Pay per lead checked |

Other coding agents (Codex, Cursor, …) work too. The full playbook is in [AGENTS.md](AGENTS.md).

## Using it

- **Type an email to your bot.** The first line is the subject; everything below it is the email.
  Write `{{name}}` where the first name should go.
- **Only for some people?** Start with a line like `to: people who asked about wholesale`.
- **Add leads:** send the bot a `.csv` file, or connect your lead platform so new leads sync every
  hour.
- Built-in protections:
  - Nobody gets two emails within 48 hours.
  - Emails only go out between 8:00 and 20:00.
  - Every email has a one-click unsubscribe link.
  - Bounces and spam complaints remove the person automatically.

## For developers

You need a Cloudflare Worker, a D1 database, and a cron that runs every minute. There are no
runtime dependencies. Run `npm test` for the tests and `npm run check` for types. Architecture,
settings and the error table are in [AGENTS.md](AGENTS.md#how-it-works-for-you-the-agent).

MIT licensed. Made by [Aditor](https://aditor.ai).
