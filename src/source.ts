// Automatic lead sync from the owner's lead platform. Runs once an hour.
//
// Default: no platform connected → leads come in by CSV (send the file to the bot) or by POST /leads.
// The setup agent replaces `pullLeads` for platforms with an API (Klaviyo, Mailchimp, HubSpot, …).
// Contract (AGENTS.md, "Connect the lead platform"):
//   - return everyone; set `unsubscribed: true` for anyone who did NOT agree to marketing email or opted out
//     (they are stored as unsubscribed and never mailed — this is how opt-outs in the platform reach JevMail)
//   - `source` = the list/form/segment name, matching a key in FUNNELS (src/business.ts)
//   - put everything useful you know about them in `facts` (quiz answers, tags, plan, country …)
//   - secrets come from `env` (set with `npx wrangler secret put NAME`), never from this file
//   - throw on failure: the hourly run logs it and tries again next hour; nothing is deleted

import type { Lead } from "./logic.ts";

export async function pullLeads(_env: Record<string, unknown>): Promise<Lead[]> {
  return [];
}
