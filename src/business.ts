// What Jev knows about YOUR business. The setup agent fills this in from the owner's answers
// and a scan of their sign-up pages (AGENTS.md, step 1). Edit freely; redeploy with `npm run deploy`.

/** 2–4 sentences: what you sell, to whom, and what your emails are for. */
export const BUSINESS = `EXAMPLE — replace me. We sell handmade ceramic coffee mugs online to home-coffee enthusiasts.
Our emails announce new glazes, restocks and brewing guides.`;

/**
 * One line per place people sign up, keyed by the lead's `source` (the list, form or page name your
 * lead platform or CSV gives them). Say what the page promised and what it asked.
 * `default` is used when a lead's source isn't listed.
 */
export const FUNNELS: Record<string, string> = {
  default: "Signed up somewhere on our website; we don't know which offer they saw.",
  // "Newsletter popup": "10% off the first order in exchange for an email.",
  // "Brew quiz": "Quiz 'Which mug fits your brewing style?' — asked brew method and cups per day.",
};
