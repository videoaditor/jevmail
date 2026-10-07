-- JevMail database (Cloudflare D1). Safe to re-run: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS leads (
  email           TEXT PRIMARY KEY,           -- lower-case
  name            TEXT,
  source          TEXT,                       -- where they signed up; key into FUNNELS in src/business.ts
  facts           TEXT NOT NULL DEFAULT '{}', -- JSON: quiz answers, tags, plan, anything known about them
  added_at        TEXT NOT NULL,
  last_sent_at    TEXT,
  unsubscribed_at TEXT,
  unsub_reason    TEXT                        -- 'link' | 'bounced' | 'complained' | 'source'
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  filter     TEXT,                            -- "to: ..." line, plain words, NULL = everyone
  status     TEXT NOT NULL,                   -- ranking | ready | sending | done | cancelled | failed | stuck
  chat_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rankings (
  broadcast_id TEXT NOT NULL,
  email        TEXT NOT NULL,
  value        REAL NOT NULL,                 -- 0..1, how much this mail is worth to this person
  filter_p     REAL,                          -- 0..1, does the "to:" line apply (NULL = no filter)
  PRIMARY KEY (broadcast_id, email)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id           TEXT PRIMARY KEY,              -- random, used in the unsubscribe link
  broadcast_id TEXT NOT NULL,
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  sent_at      TEXT,
  error        TEXT,
  UNIQUE (broadcast_id, email)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_queue ON deliveries (status, broadcast_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_sent ON deliveries (sent_at);
