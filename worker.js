// worker.js — polls sources, filters for Java FS & Frontend with C2C/W2/Full-time,
// saves to Postgres, and publishes realtime events via Redis.
require('dotenv').config();
const crypto = require("crypto");
const EventEmitter = require("events");
const Parser = require("rss-parser");
const { createClient } = require("redis");
const db = require("./db"); // <-- use db.js helper (pg Pool)

const bus = new EventEmitter();
const parser = new Parser();

// ========= CONFIG =========
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const INTERVAL_SECONDS = Number(process.env.SCAN_EVERY_SECONDS || 90);

// Employment terms (must include at least one)
const EMPLOYMENT_KEYWORDS = (process.env.EMPLOYMENT_KEYWORDS ||
  "c2c,w2,full-time,full time").split(",").map(s => s.trim().toLowerCase());

// Role keywords
const JOB_KEYWORDS = (process.env.JOB_KEYWORDS ||
  "java full stack,fullstack,backend java,spring boot,frontend,react,angular,typescript,javascript").split(",").map(s => s.trim().toLowerCase());

// Allowed locations (blank = any). Default allows US/Remote.
const LOCATIONS = (process.env.LOCATIONS || "remote,united states,usa,us").split(",").map(s => s.trim().toLowerCase());

// Realtime target user (replace with your real userId later)
const USER_ID = process.env.USER_ID || "demo";

// Email (optional; set to enable)
const RECIPIENTS = (process.env.RECIPIENTS || "").split(",").map(s => s.trim()).filter(Boolean);
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER || "alerts@example.com";

// Optional Greenhouse boards
const GREENHOUSE_COMPANIES = (process.env.GREENHOUSE_COMPANIES || "datadog,okta,twilio").split(",").map(s => s.trim());

let transporter = null; // created lazily if SMTP_* provided
let pub;                // Redis publisher

// ========= HELPERS =========
const seen = new Set();

function jobKey(job) {
  const raw = `${job.source}|${job.id || ""}|${job.url || ""}|${job.title}|${job.company}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function textBlob(job) {
  return `${job.title} ${job.company} ${job.location} ${job.description || ""}`.toLowerCase();
}

function hasAny(text, words) {
  return words.some(w => w && text.includes(w));
}

function locationOk(job) {
  if (!LOCATIONS.length) return true;
  const loc = String(job.location || "").toLowerCase();
  return hasAny(loc, LOCATIONS);
}

function matches(job) {
  const t = textBlob(job);
  const roleOk = hasAny(t, JOB_KEYWORDS);
  const employOk = hasAny(t, EMPLOYMENT_KEYWORDS) || /contract/.test(t);
  return roleOk && employOk && locationOk(job);
}

function log(m) { bus.emit("log", m); }

// ========= SOURCES =========
async function remoteOk() {
  const r = await fetch("https://remoteok.com/api");
  const data = await r.json();
  return (data || [])
    .filter(x => x && x.id && x.position)
    .map(x => ({
      id: `remoteok-${x.id}`,
      title: x.position,
      company: x.company || "RemoteOK",
      location: x.location || "Remote",
      description: (x.description || "").slice(0, 1000),
      url: x.url || x.apply_url || `https://remoteok.com/remote-jobs/${x.id}`,
      source: "remoteok",
      contract_type: null
    }));
}

async function weWorkRemotely() {
  const feed = await parser.parseURL("https://weworkremotely.com/categories/remote-programming-jobs.rss");
  return (feed.items || []).map(it => ({
    id: `wwr-${it.guid || it.link}`,
    title: it.title || "",
    company: (it.creator || it.author || "WWR").replace(/^by\s+/i, ""),
    location: "Remote",
    description: (it.contentSnippet || "").slice(0, 1000),
    url: it.link,
    source: "weworkremotely",
    contract_type: null
  }));
}

async function greenhouseBoards() {
  const out = [];
  for (const company of GREENHOUSE_COMPANIES) {
    try {
      const url = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      for (const job of (j.jobs || [])) {
        out.push({
          id: `gh-${company}-${job.id}`,
          title: job.title || "",
          company,
          location: job?.locations?.[0]?.name || job?.location?.name || "",
          description: (job?.content || "").slice(0, 1000),
          url: job.absolute_url,
          source: `greenhouse:${company}`,
          contract_type: null
        });
      }
    } catch (e) { log(`Greenhouse ${company}: ${e.message}`); }
  }
  return out;
}

async function fetchAll() {
  const fns = [remoteOk, weWorkRemotely, greenhouseBoards];
  const settled = await Promise.allSettled(fns.map(fn => fn()));
  const jobs = [];
  for (const r of settled) if (r.status === "fulfilled") jobs.push(...r.value);
  return jobs;
}

// ========= EMAIL (optional) =========
function ensureTransport() {
  if (transporter || !SMTP_USER || !SMTP_PASS) return;
  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function emailMatches(list) {
  if (!RECIPIENTS.length || !list.length) return;
  ensureTransport();
  if (!transporter) { log("Email not configured (set SMTP_* and RECIPIENTS)."); return; }
  const lines = list.slice(0, 20).map(j => `• ${j.title} @ ${j.company} (${j.location})\n  ${j.url}`);
  const text = `New matches (${list.length}):\n\n${lines.join("\n")}\n${list.length>20?`\n+ ${list.length-20} more…`: ""}`;
  await transporter.sendMail({ from: EMAIL_FROM, to: RECIPIENTS, subject: `Job Alerts: ${list.length} new`, text });
  log(`Email sent to ${RECIPIENTS.join(", ")}`);
}

// ========= DB & REDIS actions =========
async function upsertJob(j) {
  await db.query(`
    INSERT INTO job (id, source, title, company, location, contract_type, url, posted_at, description)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      company = EXCLUDED.company,
      location = EXCLUDED.location,
      contract_type = COALESCE(EXCLUDED.contract_type, job.contract_type),
      url = EXCLUDED.url,
      posted_at = COALESCE(EXCLUDED.posted_at, job.posted_at),
      description = CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE job.description END,
      fetched_at = NOW()
  `, [j.id, j.source, j.title, j.company, j.location, j.contract_type, j.url, j.posted_at || null, j.description || ""]);
}

async function publishRealtime(job) {
  if (!pub) return;
  const payload = {
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
    contract: job.contract_type || null,
    ts: Date.now()
  };
  await pub.publish(`notifications:${USER_ID}`, JSON.stringify(payload));
}

// ========= POLL CYCLE =========
async function runCycle() {
  try {
    const all = await fetchAll();
    const fresh = [];
    for (const j of all) {
      const k = jobKey(j);
      if (seen.has(k)) continue;
      seen.add(k);

      if (matches(j)) {
        // save and publish
        await upsertJob(j);
        await publishRealtime(j);
        fresh.push(j);
        bus.emit("job", j);
      }
    }
    bus.emit("stats", { ts: Date.now(), fetched: all.length, new: fresh.length, seen: seen.size });
    await emailMatches(fresh);
    log(`Cycle: fetched=${all.length}, new=${fresh.length}, seen=${seen.size}`);
  } catch (e) {
    log(`Cycle failed: ${e.message}`);
  }
}

function scanNow() { runCycle(); }

// ========= STARTUP =========
(async function main() {
  try {
    pub = createClient({ url: REDIS_URL });
    pub.on("error", (e) => console.error("Redis pub error:", e));
    await pub.connect();

    log(`Worker started. Interval=${INTERVAL_SECONDS}s`);
    await runCycle();
    setInterval(runCycle, INTERVAL_SECONDS * 1000);

    process.on("SIGINT", async () => { try { await pub.quit(); } finally { process.exit(0); } });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();

module.exports = { bus, scanNow };
