/**
 * day-planner - Cloudflare Worker (Corby & Associates)
 *
 * Every weekday ~08:00 MT, DMs Jamie (as CorbyBot) a prioritised "what to work
 * on today" plan built from his open tasks in the C&A Task Tracker, fitted to
 * the free time on his calendar within working hours (09:00-17:00 MT). Each
 * suggested task carries Slack buttons: Done / Defer to tomorrow / Snooze /
 * Delegate, plus a Re-prioritise button. If high-priority work won't fit the
 * 09-17 day, it asks whether to start earlier or run into the evening.
 *
 * Secrets: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, GCP_SA_EMAIL, GCP_SA_KEY (PEM),
 *          ANTHROPIC_API_KEY, RUN_TOKEN.
 * Binding:  KV.
 * Cron (UTC): 0 14 * * 1-5  (~08:00 America/Denver in summer).
 * Routes (Bearer RUN_TOKEN): /plan/health, /plan/run.
 * Webhook (Slack-signed): /slack/interact.
 */

const SHEET_ID = "1GH7BYc74n2-SVNwzr_F6EvwXjWMA19xnLxKZ9zJ2tqA";
const TRACKER_TAB = "Task Tracker";
const DELEG_TAB = "Delegation";
const JAMIE_EMAIL = "jamie@corby.associates";
const TZ = "America/Denver";
const WORK_START = 9;   // 09:00 local
const WORK_END = 17;    // 17:00 local
const EVENING_END = 21; // when "into the evening" is chosen
const EARLY_START = 7;  // when "start earlier" is chosen
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar.readonly";

const DELEG_COLS = ["Date assigned","Tracker IDs","Assignee","Brief","Channel","Internal deadline","Client deadline","Status","Last update","Review needed","Notes"];

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runPlan(env, "cron").then(noop).catch((e)=>console.log("sched err", String(e)))); },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/slack/interact") return handleInteract(req, env, ctx);
    const auth = req.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.RUN_TOKEN}`) return new Response("unauthorised", { status: 401 });
    if (url.pathname === "/plan/health") return json(await health(env));
    if (url.pathname === "/plan/run") return json(await runPlan(env, "http"));
    return new Response("not found", { status: 404 });
  },
};

/* ---------------- main ---------------- */

async function runPlan(env, trigger, opts = {}) {
  const log = { tasks: 0, suggested: 0, overflow: false, freeMins: 0, errors: [] };
  try {
    const gtok = await googleToken(env);
    const tasks = await readOpenJamieTasks(env, gtok);
    log.tasks = tasks.length;
    const startH = opts.startH || WORK_START;
    const endH = opts.endH || WORK_END;
    const free = await calendarFreeSlots(env, gtok, startH, endH);
    log.freeMins = free.totalMins;

    const plan = await buildPlan(env, tasks, free, { startH, endH });
    log.suggested = (plan.today || []).length;
    log.overflow = !!plan.overflow;

    await postPlan(env, gtok, plan, free, { startH, endH });
  } catch (e) {
    log.errors.push(String(e));
    try { await dmJamie(env, `Day planner ${trigger} run failed: ${String(e).slice(0,300)}`); } catch {}
  }
  try { await appendRunLog(env, await googleToken(env), trigger, log); } catch {}
  return log;
}

async function buildPlan(env, tasks, free, hours) {
  if (!tasks.length) return { today: [], overflow: false, note: "No open tasks owned by you - clear list." };
  const rows = tasks.map((t) => ({ id: t.ID, client: t.Client, item: t.Item, action: t["Suggested Action"], urgency: t.Urgency, deadline: t.Deadline || "" }));
  const prompt =
`You are planning Jamie's working day. Today (MT): ${mtDateISO()}. Working window: ${hours.startH}:00-${hours.endH}:00.
He has ${Math.round(free.totalMins)} minutes of free time today (gaps between meetings): ${free.slots.map(s=>s.label).join(", ") || "none mapped"}.
Below are his open tasks. Choose and ORDER the ones he should do today so the total estimated effort fits his free time, prioritising by deadline (sooner = higher) then urgency. Give a realistic "estMins" per task. Keep it focused - quality over quantity.
If the HIGH-PRIORITY tasks (near deadline / urgent) need MORE time than is free in the working window, set "overflow": true and list the overflow task ids in "overflowIds" - do not silently drop them.
Return ONLY JSON: {"today":[{"id":"...","estMins":60,"why":"one short line"}],"overflow":false,"overflowIds":[],"summary":"1-2 sentence framing of the day"}
Tasks: ${JSON.stringify(rows)}`;
  let parsed;
  try { parsed = JSON.parse(extractJson(await claude(env, prompt, 2000))); } catch (e) { parsed = { today: [], overflow: false }; }
  const byId = new Map(tasks.map((t) => [t.ID, t]));
  parsed.today = (parsed.today || []).filter((x) => byId.has(x.id)).map((x) => ({ ...x, task: byId.get(x.id) }));
  parsed.overflowIds = (parsed.overflowIds || []).filter((id) => byId.has(id));
  return parsed;
}

/* ---------------- slack output ---------------- */

async function postPlan(env, gtok, plan, free, hours) {
  if (!plan.today || !plan.today.length) {
    await dmJamie(env, plan.note || "Nothing to suggest for today.");
    return;
  }
  const freeH = (free.totalMins / 60).toFixed(1);
  const header = `*Your plan for ${mtDateLong()}*\nFree time today: *${freeH}h* (working ${hours.startH}:00-${hours.endH}:00).${plan.summary ? `\n${plan.summary}` : ""}`;
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: header } }, { type: "divider" }];

  let n = 0;
  for (const item of plan.today) {
    n++;
    const t = item.task;
    const token = shortToken();
    await env.KV.put(`plan:item:${token}`, JSON.stringify({ id: t.ID, item: t.Item, client: t.Client, deadline: t.Deadline || "" }), { expirationTtl: 172800 });
    const dl = t.Deadline ? ` · due ${t.Deadline}` : "";
    const est = item.estMins ? ` · ~${item.estMins}m` : "";
    const line = `*${n}. ${t.Item}*  _(${t.Client || "—"}${dl}${est})_${item.why ? `\n   ${item.why}` : ""}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: line } });
    blocks.push({ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Done" }, style: "primary", action_id: "plan_done", value: token },
      { type: "button", text: { type: "plain_text", text: "Defer to tomorrow" }, action_id: "plan_defer", value: token },
      { type: "button", text: { type: "plain_text", text: "Snooze" }, action_id: "plan_snooze", value: token },
      { type: "button", text: { type: "plain_text", text: "Delegate" }, action_id: "plan_delegate", value: token },
    ] });
  }

  blocks.push({ type: "divider" });
  const footer = [{ type: "button", text: { type: "plain_text", text: "Re-prioritise" }, action_id: "plan_replan", value: `${hours.startH}-${hours.endH}` }];
  if (plan.overflow && plan.overflowIds && plan.overflowIds.length) {
    await env.KV.put(`plan:overflow:today`, JSON.stringify(plan.overflowIds), { expirationTtl: 86400 });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `:warning: *${plan.overflowIds.length} high-priority task(s) won't fit 9-5.* Want to make room?` } });
    blocks.push({ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Start earlier (from 7am)" }, action_id: "plan_early", value: "early" },
      { type: "button", text: { type: "plain_text", text: "Into the evening (to 9pm)" }, action_id: "plan_evening", value: "evening" },
      { type: "button", text: { type: "plain_text", text: "Leave for tomorrow" }, action_id: "plan_leave", value: "leave" },
    ] });
  } else {
    blocks.push({ type: "actions", elements: footer });
  }
  await postJamie(env, "Your plan for today", blocks);
}

/* ---------------- interactivity ---------------- */

async function handleInteract(req, env, ctx) {
  const body = await req.text();
  if (env.SLACK_SIGNING_SECRET && !(await verifySlack(req, body, env.SLACK_SIGNING_SECRET))) return new Response("bad sig", { status: 401 });
  const params = new URLSearchParams(body);
  let payload; try { payload = JSON.parse(params.get("payload") || "{}"); } catch { return new Response("", { status: 200 }); }
  if (payload.type !== "block_actions") return new Response("", { status: 200 });
  const a = (payload.actions || [])[0] || {};
  ctx.waitUntil(routeAction(env, a, payload).catch((e)=>console.log("act err", String(e))));
  return new Response("", { status: 200 });
}

async function routeAction(env, a, payload) {
  const id = a.action_id, token = a.value;
  if (id === "plan_done") return planDone(env, token, payload);
  if (id === "plan_defer") return planMark(env, token, payload, "defer");
  if (id === "plan_snooze") return planMark(env, token, payload, "snooze");
  if (id === "plan_delegate") return planDelegate(env, token, payload);
  if (id === "plan_replan") { const [s,e] = (token||"9-17").split("-").map(Number); await replyEphemeralReplace(env, payload, "Re-prioritising..."); return runPlan(env, "replan", { startH: s||WORK_START, endH: e||WORK_END }); }
  if (id === "plan_early") return runPlan(env, "overflow-early", { startH: EARLY_START, endH: WORK_END });
  if (id === "plan_evening") return runPlan(env, "overflow-evening", { startH: WORK_START, endH: EVENING_END });
  if (id === "plan_leave") return updateMsg(env, payload, "Left the overflow for tomorrow - today's plan stands.");
}

async function planDone(env, token, payload) {
  const it = await loadItem(env, token); if (!it) return ack(env, payload, "That item has expired.");
  const gtok = await googleToken(env);
  await setTrackerStatus(env, gtok, it.id, "Done");
  await env.KV.delete(`plan:item:${token}`);
  await ack(env, payload, `Done: ${it.item} - marked complete on the tracker.`);
}
async function planMark(env, token, payload, kind) {
  const it = await loadItem(env, token); if (!it) return ack(env, payload, "That item has expired.");
  const until = kind === "defer" ? mtDateISO(1) : mtDateISO(1);
  await env.KV.put(`plan:skip:${it.id}`, JSON.stringify({ kind, until }), { expirationTtl: 172800 });
  await env.KV.delete(`plan:item:${token}`);
  await ack(env, payload, kind === "defer" ? `Deferred: ${it.item} - it'll lead tomorrow's plan.` : `Snoozed: ${it.item} - hidden from today.`);
}
async function planDelegate(env, token, payload) {
  const it = await loadItem(env, token); if (!it) return ack(env, payload, "That item has expired.");
  const gtok = await googleToken(env);
  const row = {}; DELEG_COLS.forEach((c) => (row[c] = ""));
  row["Date assigned"] = mtDateISO(); row["Tracker IDs"] = it.id; row["Brief"] = it.item; row["Channel"] = "Slack";
  row["Client deadline"] = it.deadline || ""; row["Status"] = "Queued"; row["Last update"] = mtDateISO();
  row["Notes"] = "Queued from day-planner";
  await sheetsWrite(env, gtok, `${DELEG_TAB}!A1:K1`, [DELEG_COLS.map((c) => row[c] || "")], true);
  await env.KV.delete(`plan:item:${token}`);
  await ack(env, payload, `Queued for delegation: ${it.item} - the delegation loop will propose an assignee at its next run.`);
}

/* ---------------- google: token / sheets / calendar ---------------- */

async function googleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const claim = b64url(JSON.stringify({ iss: env.GCP_SA_EMAIL, sub: JAMIE_EMAIL, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const input = `${header}.${claim}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToArr(env.GCP_SA_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const jwt = `${input}.${b64url(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const j = await r.json();
  if (!j.access_token) throw new Error("google auth failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function readOpenJamieTasks(env, gtok) {
  const v = await sheetsGet(env, gtok, `${TRACKER_TAB}!A1:V500`);
  const head = v[0] || [];
  const rows = v.slice(1).map((row) => { const o = {}; head.forEach((h, c) => (o[h] = row[c] || "")); return o; })
    .filter((o) => o.ID && o.Status === "Open" && o.Owner === "Jamie");
  // drop snoozed/deferred-not-yet-due
  const out = [];
  for (const o of rows) {
    const skipRaw = await env.KV.get(`plan:skip:${o.ID}`);
    if (skipRaw) { const s = JSON.parse(skipRaw); if (s.kind === "snooze" && s.until >= mtDateISO()) continue; }
    out.push(o);
  }
  return out;
}

async function calendarFreeSlots(env, gtok, startH, endH) {
  const { startISO, endISO } = workWindowISO(startH, endH);
  try {
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST", headers: { Authorization: `Bearer ${gtok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: startISO, timeMax: endISO, items: [{ id: "primary" }] }),
    });
    const j = await r.json();
    const busy = ((j.calendars && j.calendars.primary && j.calendars.primary.busy) || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]).sort((a, b) => a[0] - b[0]);
    let cursor = Date.parse(startISO); const end = Date.parse(endISO); const slots = []; let totalMins = 0;
    for (const [bs, be] of busy) { if (bs > cursor) { slots.push(slot(cursor, Math.min(bs, end))); totalMins += (Math.min(bs, end) - cursor) / 60000; } cursor = Math.max(cursor, be); if (cursor >= end) break; }
    if (cursor < end) { slots.push(slot(cursor, end)); totalMins += (end - cursor) / 60000; }
    return { totalMins: Math.max(0, Math.round(totalMins)), slots: slots.filter((s) => s.mins >= 15) };
  } catch (e) {
    // calendar unavailable: assume the whole working window is free
    const mins = (endH - startH) * 60;
    return { totalMins: mins, slots: [{ label: `${startH}:00-${endH}:00 (calendar unavailable)`, mins }] };
  }
}
function slot(a, b) { const f = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(t)); const mins = Math.round((b - a) / 60000); return { label: `${f(a)}-${f(b)}`, mins }; }

async function setTrackerStatus(env, gtok, id, status) {
  const v = await sheetsGet(env, gtok, `${TRACKER_TAB}!A1:V500`);
  const head = v[0] || []; const idC = head.indexOf("ID"), stC = head.indexOf("Status");
  if (idC < 0 || stC < 0) return;
  for (let i = 1; i < v.length; i++) { if ((v[i][idC] || "").trim() === id) { await sheetsWrite(env, gtok, `${TRACKER_TAB}!${colLetter(stC)}${i + 1}`, [[status]]); return; } }
}

/* ---------------- slack helpers ---------------- */

async function slack(env, method, payload) {
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json(); if (!j.ok) throw new Error(`slack ${method}: ${j.error}`); return j;
}
async function jamieChannel(env) {
  let ch = await env.KV.get(`plan:dm`); if (ch) return ch;
  let uid = await env.KV.get(`plan:uid`);
  if (!uid) { const r = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(JAMIE_EMAIL)}`, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } }); const j = await r.json(); if (!j.ok) throw new Error("lookupByEmail: " + j.error); uid = j.user.id; await env.KV.put(`plan:uid`, uid); }
  const o = await slack(env, "conversations.open", { users: uid }); ch = o.channel.id; await env.KV.put(`plan:dm`, ch); return ch;
}
async function postJamie(env, text, blocks) { const ch = await jamieChannel(env); await slack(env, "chat.postMessage", { channel: ch, text, blocks }); }
async function dmJamie(env, text) { const ch = await jamieChannel(env); await slack(env, "chat.postMessage", { channel: ch, text }); }
async function updateMsg(env, payload, text) { try { const channel = (payload.channel && payload.channel.id) || (payload.container && payload.container.channel_id); const ts = (payload.message && payload.message.ts) || (payload.container && payload.container.message_ts); if (channel && ts) await slack(env, "chat.update", { channel, ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }); } catch {} }
async function ack(env, payload, text) { await dmJamie(env, text); }
async function replyEphemeralReplace(env, payload, text) { await updateMsg(env, payload, text); }

async function verifySlack(req, body, secret) {
  const ts = req.headers.get("X-Slack-Request-Timestamp") || ""; const sig = req.headers.get("X-Slack-Signature") || "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}` === sig;
}

/* ---------------- sheets io ---------------- */
async function sheetsGet(env, gtok, range) { const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${gtok}` } }); const j = await r.json(); if (j.error) throw new Error("sheets get: " + j.error.message); return j.values || []; }
async function sheetsWrite(env, gtok, range, values, append = false) {
  const url = append ? `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS` : `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, { method: append ? "POST" : "PUT", headers: { Authorization: `Bearer ${gtok}`, "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
  const j = await r.json(); if (j.error) throw new Error("sheets write: " + j.error.message); return j;
}
async function appendRunLog(env, gtok, trigger, log) { try { await sheetsWrite(env, gtok, `_Worker Run Log!A1:H1`, [[crypto.randomUUID().slice(0,8), new Date().toISOString(), "day-planner", trigger, log.freeMins, log.errors.length?"error":"ok", JSON.stringify(log), log.errors.join("; ")]], true); } catch {} }

/* ---------------- anthropic ---------------- */
async function claude(env, prompt, maxTokens = 1000) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json(); if (j.error) throw new Error("anthropic: " + j.error.message); return (j.content || []).map((c) => c.text || "").join("");
}

/* ---------------- util ---------------- */
async function loadItem(env, token) { const raw = await env.KV.get(`plan:item:${token}`); return raw ? JSON.parse(raw) : null; }
async function health(env) {
  const out = { slack: false, sheets: false, calendar: false, anthropic: false, kv: false };
  try { await slack(env, "auth.test", {}); out.slack = true; } catch (e) { out.slackErr = String(e); }
  let gtok; try { gtok = await googleToken(env); } catch (e) { out.authErr = String(e); }
  if (gtok) { try { await sheetsGet(env, gtok, `${TRACKER_TAB}!A1:A1`); out.sheets = true; } catch (e) { out.sheetsErr = String(e); }
    try { const f = await calendarFreeSlots(env, gtok, WORK_START, WORK_END); out.calendar = true; out.freeMins = f.totalMins; } catch (e) { out.calErr = String(e); } }
  try { await claude(env, "Reply OK", 5); out.anthropic = true; } catch (e) { out.anthropicErr = String(e); }
  try { await env.KV.put("plan:health", "1"); out.kv = true; } catch (e) { out.kvErr = String(e); }
  return out;
}
function json(obj) { return new Response(JSON.stringify(obj, null, 2), { headers: { "Content-Type": "application/json" } }); }
function workWindowISO(startH, endH) {
  // build today's start/end in MT, return ISO with offset
  const now = new Date(); const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
  const offMin = tzOffsetMinutes(TZ, now); const sign = offMin <= 0 ? "-" : "+"; const ab = Math.abs(offMin); const off = `${sign}${String(Math.floor(ab/60)).padStart(2,"0")}:${String(ab%60).padStart(2,"0")}`;
  const pad = (n) => String(n).padStart(2, "0");
  return { startISO: `${ymd}T${pad(startH)}:00:00${off}`, endISO: `${ymd}T${pad(endH)}:00:00${off}` };
}
function tzOffsetMinutes(tz, date) { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }); const part = dtf.formatToParts(date).find((p) => p.type === "timeZoneName"); const m = (part && part.value || "GMT-7").match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/); if (!m) return -420; return parseInt(m[1], 10) * 60 + (m[2] ? Math.sign(parseInt(m[1],10)) * parseInt(m[2], 10) : 0); }
function mtDateISO(plusDays = 0) { const d = new Date(Date.now() + plusDays * 86400000); return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); }
function mtDateLong() { return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date()); }
function extractJson(s) { const m = (s || "").match(/\{[\s\S]*\}/); return m ? m[0] : "{}"; }
function shortToken() { return crypto.randomUUID().replace(/-/g, "").slice(0, 6); }
function colLetter(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function b64url(data) { const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data); let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function pemToArr(pem) {
  let s = String(pem || "").trim();
  if (s.charAt(0) === "{") { try { const j = JSON.parse(s); if (j && j.private_key) s = String(j.private_key).trim(); } catch (e) {} }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  s = s.replace(/-----[A-Za-z0-9 ]+-----/g, ""); // strip BEGIN/END header lines
  s = s.replace(/\\r/g, "").replace(/\\n/g, ""); // literal escaped newlines from JSON
  s = s.replace(/[^A-Za-z0-9+/=]/g, ""); // keep only valid base64 chars (drops real newlines, quotes, stray backslashes)
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
function noop() {}
