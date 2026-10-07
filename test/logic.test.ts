import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJevRequest, csvToLeads, parseCsv, parseJev, parseMail, personState, pickRecipients, renderMail, verifySvix } from "../src/logic.ts";

test("parseMail: subject line, body, optional to: filter, owner's words untouched", () => {
  const m = parseMail("to: people who asked about wholesale\n\nNew bulk pricing\nHi {{name}},\n\nwe now do wholesale. Reply if you want the list.");
  assert.deepEqual(m, { ok: true, filter: "people who asked about wholesale", subject: "New bulk pricing", body: "Hi {{name}},\n\nwe now do wholesale. Reply if you want the list." });
  assert.equal(parseMail("Subject: Hello\nThis body is definitely long enough.").ok, true);
  assert.equal(parseMail("Only a subject").ok, false);
  assert.equal(parseMail("   \n").ok, false);
});

test("parseCsv: quotes, commas in cells, semicolon exports, BOM, CRLF", () => {
  assert.deepEqual(parseCsv('﻿Email,Note\r\na@b.co,"hi, ""you"""\r\n'), [["Email", "Note"], ["a@b.co", 'hi, "you"']]);
  assert.deepEqual(parseCsv("E-Mail;Vorname\nx@y.de;Jörg\n\n"), [["E-Mail", "Vorname"], ["x@y.de", "Jörg"]]);
});

test("csvToLeads: finds email + first name, keeps the rest as facts, opt-outs become unsubscribed", () => {
  const rows = parseCsv("First Name,Email,Accepts Email Marketing,Quiz answer\nAna,ANA@x.com ,yes,Pour-over\nBo,bo@x.com,no,\n,not-an-email,yes,x");
  const r = csvToLeads(rows, "Brew quiz");
  assert.equal(r.noEmail, 1);
  assert.equal(r.noConsent, 1);
  assert.deepEqual(r.leads[0], { email: "ana@x.com", name: "Ana", source: "Brew quiz", facts: { "Accepts Email Marketing": "yes", "Quiz answer": "Pour-over" } });
  assert.equal(r.leads[1].unsubscribed, true);
});

test("personState: never sends contact details to the model, maps source to the funnel", () => {
  const p = personState(
    { source: "Brew quiz", facts: JSON.stringify({ Phone: "+49 1", "Last Name": "X", Zip: "10115", "Shipping method": "DHL", "Quiz answer": "Pour-over" }) },
    { "Brew quiz": "Which mug fits your brewing style?", default: "?" },
  );
  assert.deepEqual(p, { signed_up_via: "Brew quiz", that_page_offered: "Which mug fits your brewing style?", facts: { "Shipping method": "DHL", "Quiz answer": "Pour-over" } });
  assert.equal(personState({ source: null, facts: "broken{" }, { default: "site" }).that_page_offered, "site");
});

test("Jev request + answer parsing", () => {
  const req = buildJevRequest({ subject: "S", body: "B" }, {}, "biz", "in Norway") as any;
  assert.deepEqual(Object.keys(req.questions), ["value", "filter"]);
  assert.equal(buildJevRequest({ subject: "S", body: "B" }, {}, "biz", null).questions.filter, undefined);
  assert.deepEqual(parseJev({ answers: { value: { score: 1.5 }, filter: { noul: 0.9 } } }, true), { value: 0.5, filter_p: 0.9 });
  assert.equal(parseJev({ answers: { value: { score: 7 } } }, false), null);
  assert.equal(parseJev({ answers: { value: { score: 2 } } }, true), null); // asked for filter, got none
});

test("pickRecipients: filter is a hard gate, 'cares' is a threshold, numbers are top N", () => {
  const rows = [
    { email: "a", value: 0.9, filter_p: 0.9 },
    { email: "b", value: 1.0, filter_p: 0.2 }, // most interested but outside the filter
    { email: "c", value: 0.6, filter_p: 0.8 },
    { email: "d", value: 0.1, filter_p: 0.7 },
  ];
  assert.deepEqual(pickRecipients(rows, "cares"), ["a", "c"]);
  assert.deepEqual(pickRecipients(rows, 3), ["a", "c", "d"]);
  assert.deepEqual(pickRecipients([{ email: "x", value: 0.5, filter_p: null }], "cares"), ["x"]);
});

test("renderMail: first name, escaping, links, unsubscribe footer", () => {
  const { text, html } = renderMail("Hi {{name}} <3\n\nSee https://x.com/a?b=1", "Ana Lopez", "https://w.dev/u/abc");
  assert.match(text, /^Hi Ana <3/);
  assert.match(text, /Unsubscribe: https:\/\/w\.dev\/u\/abc$/);
  assert.match(html, /Hi Ana &lt;3/);
  assert.match(html, /<a href="https:\/\/x.com\/a\?b=1">/);
  assert.match(renderMail("Hey ((name))!", null, "u").text, /^Hey there!/);
});

test("verifySvix: accepts Resend's signature, rejects tampering and old timestamps", async () => {
  const secret = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("0123456789abcdef0123456789abcdef"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("msg_1.1000.{}")))));
  assert.equal(await verifySvix(secret, "msg_1", "1000", "{}", `v1,${sig}`, 1000), true);
  assert.equal(await verifySvix(secret, "msg_1", "1000", '{"x":1}', `v1,${sig}`, 1000), false);
  assert.equal(await verifySvix(secret, "msg_1", "1000", "{}", `v1,${sig}`, 5000), false);
});
