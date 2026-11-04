// ═══ Tropa Club · api/tg.js · ВЕРСІЯ g1 ═══
// ═══════════════════════════════════════════════════════════════════
// ВХІД ЧЕРЕЗ TELEGRAM — застосунок лише для учасників групи (v146)
//
// ЯК ЦЕ ПРАЦЮЄ
//  1. Людина відкриває застосунок і натискає «Увійти через Telegram».
//     Застосунок бере тут одноразовий код (begin) і відкриває бота:
//     t.me/<бот>?start=<код>.
//  2. Людина тисне «Start» у Telegram. Telegram надсилає це сюди
//     (webhook). Сервер питає Telegram, чи людина в групі (getChatMember),
//     і відповідає їй у боті: «Готово» або «спершу приєднайся до групи».
//  3. Застосунок, поки чекав, питав про свій код (poll) — і отримує
//     підписаний квиток (token). Квиток лежить у телефоні; підробити його
//     не можна (підпис ключем, виведеним із токена бота).
//  4. При кожному відкритті застосунок показує квиток (check). Сервер раз
//     на добу заново питає Telegram, чи людина ще в групі. Вийшла —
//     доступ закрито, а сповіщення на її телефони більше не йдуть.
//     Якщо бот — адміністратор групи, Telegram сам повідомляє про вихід
//     (chat_member), і доступ закривається одразу.
//
// ЗМІННІ СЕРЕДОВИЩА (Vercel → Settings → Environment Variables)
//  • TELEGRAM_BOT_TOKEN — токен бота від @BotFather. Живе ЛИШЕ тут.
//    Немає токена — перевірки немає зовсім: застосунок відкритий, як до v146.
//  • TELEGRAM_GROUP — необов'язково: група, якщо не @tropa_club
//    (@назва або числовий номер на кшталт -1001234567890).
//  • TELEGRAM_GATE=off — тимчасово вимкнути перевірку, не видаляючи бота.
//  • SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
//    PUSH_SECRET, CRON_SECRET — ті самі, що вже є.
// Потрібен supabase-v146.sql (таблиці tg_members, tg_logins, tg_devices).
//
// ДІЇ (POST { action })
//   status            — чи ввімкнено перевірку (для застосунку без квитка)
//   begin             — новий одноразовий код і посилання на бота
//   poll { nonce }    — чи підтвердив Telegram цей код
//   check { token }   — чи квиток дійсний і людина ще в групі
//   link { token, endpoint } — прив'язати push-підписку телефона до людини
//   pin { pin }       — квиток організатора за PIN (без Telegram)
//   admin { pin }     — зведення для організатора
//   cleanup { pin }   — вимкнути сповіщення телефонам без входу
//   sweep { secret }  — щоденна звірка (кличе годинник push-cron)
// GET — перевірка налаштувань без секретів; заодно ставить webhook.
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

export const config = { maxDuration: 30 };
export const VERSION = "g1";

const TG = "https://api.telegram.org";
const NONCE_MIN = 30;            // код входу живе 30 хвилин
const RECHECK_H = 20;            // членство звіряємо, якщо минуло 20+ годин
const SWEEP_LIMIT = 40;          // скільки людей звіряє один виклик годинника (раз на годину)
const ADMIN_DAYS = 180;          // квиток організатора (за PIN) діє півроку
const IN = ["creator", "administrator", "member"];

const env = () => ({
  bot: String(process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  // Ключ підпису квитків — від службового ключа бази, а не від токена бота:
  // так заміна токена бота не розлогінює всіх учасників.
  sess: String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  group: String(process.env.TELEGRAM_GROUP || "").trim() || "@tropa_club",
  off: /^(off|0|no|false|ні)$/i.test(String(process.env.TELEGRAM_GATE || "").trim()),
  url: process.env.SUPABASE_URL, svc: process.env.SUPABASE_SERVICE_ROLE_KEY, anon: process.env.SUPABASE_ANON_KEY,
});
const APP_HOST = () => String(process.env.VERCEL_PROJECT_PRODUCTION_URL || "tropa-club.vercel.app").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const appUrl = (path = "/") => `https://${APP_HOST()}${path}`;

const b64u = (b) => Buffer.from(b).toString("base64url");
const sessionKey = (secret) => crypto.createHash("sha256").update(`tropa-session|${secret}`).digest();
export const hookSecret = (bot) => crypto.createHash("sha256").update(`tropa-hook|${bot}`).digest("hex").slice(0, 48);
// Адреса webhook несе відбиток секрету: замінили токен бота — адреса інша,
// і сервер сам перереєструє webhook із новим секретом (інакше Telegram
// слав би старий секрет, і кожне «Start» відбивалося б).
const hookPath = (bot) => `/api/tg?h=${hookSecret(bot).slice(0, 10)}`;
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const nameOf = (u) => clean([u && u.first_name, u && u.last_name].filter(Boolean).join(" "), 60) || clean(u && u.username, 40) || "учасник";
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const isIn = (st) => IN.includes(st) || st === "restricted";

// ── Квиток ──────────────────────────────────────────────────────────
// { u: номер у Telegram (0 — організатор за PIN), n: ім'я, t: коли,
//   a: 1 — організатор, e: до коли діє (лише в організатора) }
export function signToken(secret, payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac("sha256", sessionKey(secret)).update(body).digest());
  return `${body}.${sig}`;
}
export function readToken(secret, token) {
  const m = String(token || "").match(/^([A-Za-z0-9_-]{8,600})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m || !secret) return null;
  const want = b64u(crypto.createHmac("sha256", sessionKey(secret)).update(m[1]).digest());
  const a = Buffer.from(want), b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    if (!p || typeof p !== "object") return null;
    if (p.a === 1) {
      if (!Number(p.e) || Date.now() / 1000 > Number(p.e)) return null;
      return { admin: true, uid: 0, name: clean(p.n, 60) || "організатор" };
    }
    const uid = Number(p.u);
    if (!Number.isSafeInteger(uid) || uid <= 0) return null;
    return { admin: false, uid, name: clean(p.n, 60) };
  } catch { return null; }
}

// ── Telegram ────────────────────────────────────────────────────────
export async function tgCall(bot, method, params, ms = 8000) {
  let r;
  try {
    r = await fetch(`${TG}/bot${bot}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {}), signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    return { ok: false, net: true, description: String((e && e.message) || e).slice(0, 120) };
  }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!j) return { ok: false, net: true, description: `Telegram відповів ${r.status}` };
  return j;
}
// Чи людина в групі: { state: "in" | "out" | "error", status, why }.
// «error» — Telegram не відповів або бот не бачить групи: тоді нікого не
// виганяємо (краще пропустити, ніж зачинити двері своїм).
export async function memberState(bot, group, uid) {
  const j = await tgCall(bot, "getChatMember", { chat_id: group, user_id: uid });
  if (j && j.ok && j.result) {
    const st = String(j.result.status || "");
    const inside = IN.includes(st) || (st === "restricted" && j.result.is_member === true);
    // Статус для бази — однозначний: «restricted» лише для тих, хто в групі;
    // обмежений, що вийшов, — «left» (інакше наступна перевірка пустила б).
    return { state: inside ? "in" : "out", status: inside ? st : (st === "kicked" ? "kicked" : "left") };
  }
  const d = String((j && j.description) || "");
  if (j && !j.net && /user not found|participant_id_invalid|member not found|USER_ID_INVALID/i.test(d)) return { state: "out", status: "left" };
  return { state: "error", status: "", why: d.slice(0, 120) || "Telegram не відповів" };
}
let BOT_ME = null;
async function botMe(bot) {
  if (BOT_ME && BOT_ME.token === bot) return BOT_ME.me;
  const j = await tgCall(bot, "getMe", {}, 6000);
  if (j && j.ok && j.result) { BOT_ME = { token: bot, me: j.result }; return j.result; }
  return null;
}
let HOOK_DONE = false;
// Готовність (g1): перевірка вмикається, лише коли все налаштовано — бот
// відповідає, бачить групу й він у ній адміністратор, webhook стоїть на
// цю адресу з чинним секретом, а в базі є таблиці входу. Інакше застосунок
// лишається відкритим: помилка в налаштуваннях не має зачинити двері всім.
// Відповідь пам'ятаємо 10 хвилин (невдалу — 2).
let READY = null;
export function resetReady() { READY = null; BOT_ME = null; HOOK_DONE = false; }
async function ready(C, E) {
  if (READY && READY.bot === C.bot && Date.now() - READY.at < (READY.ok ? 600000 : 120000)) return READY;
  let why = "";
  const me = await botMe(C.bot);
  if (!me) why = "бот не відповідає або токен неправильний";
  if (!why) {
    const g = await tgCall(C.bot, "getChat", { chat_id: C.group }, 6000);
    if (!(g && g.ok)) why = `бот не бачить групу ${C.group} — додай його в групу адміністратором`;
  }
  if (!why) {
    const bm = await tgCall(C.bot, "getChatMember", { chat_id: C.group, user_id: me.id }, 6000);
    const st = bm && bm.ok && bm.result ? String(bm.result.status || "") : "";
    if (st !== "administrator" && st !== "creator") why = `бот не адміністратор групи ${C.group} — зроби його адміністратором (права можна не давати)`;
  }
  if (!why) {
    try { await db(E, "GET", "tg_logins?select=nonce&limit=1"); }
    catch (e) { why = setupHint(e) || "база не відповіла"; }
  }
  if (!why) {
    const h = await ensureHook(C.bot).catch(() => ({ ok: false, why: "Telegram не відповів" }));
    if (!h.ok) why = `webhook не встановлено (${h.why || "невідомо чому"})`;
    else HOOK_DONE = true;
  }
  READY = { bot: C.bot, at: Date.now(), ok: !why, why };
  return READY;
}
const isProd = () => !process.env.VERCEL_ENV || process.env.VERCEL_ENV === "production";
// Webhook — адреса, куди Telegram шле «Start». Ставимо лише з основної
// адреси сайту: тестова збірка Vercel не має перехоплювати бота.
async function ensureHook(bot) {
  if (!isProd()) return { ok: false, why: "не основна збірка" };
  const want = appUrl(hookPath(bot));
  const info = await tgCall(bot, "getWebhookInfo", {}, 6000);
  const cur = info && info.ok && info.result ? info.result : null;
  const updates = cur && Array.isArray(cur.allowed_updates) ? cur.allowed_updates : [];
  if (cur && cur.url === want && updates.includes("chat_member")) return { ok: true, set: false };
  const j = await tgCall(bot, "setWebhook", { url: want, secret_token: hookSecret(bot), allowed_updates: ["message", "chat_member"], drop_pending_updates: true }, 8000);
  return j && j.ok ? { ok: true, set: true } : { ok: false, why: clean(j && j.description, 120) };
}

// ── База (службовий ключ; таблиці закриті для телефонів) ─────────────
async function db(E, method, path, body, extra) {
  const r = await fetch(`${E.url}/rest/v1/${path}`, {
    method,
    headers: { apikey: E.svc, Authorization: `Bearer ${E.svc}`, "Content-Type": "application/json", ...(extra || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const txt = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${path.split("?")[0]}: ${r.status} ${txt.slice(0, 160)}`), { status: r.status, body: txt });
  return txt ? JSON.parse(txt) : null;
}
const upsert = (E, table, rows, key) => db(E, "POST", `${table}?on_conflict=${key}`, rows, { Prefer: "resolution=merge-duplicates,return=minimal" });
async function rpc(E, fn, body, key) {
  const k = key || E.svc;
  const r = await fetch(`${E.url}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${txt.slice(0, 160)}`);
  return txt ? JSON.parse(txt) : null;
}
const pinOk = async (E, pin) => Boolean(pin) && (await rpc(E, "check_pin", { pin: String(pin) }).catch(() => null)) === true;
const setupHint = (e) => (/tg_(members|logins|devices)/.test(String(e && e.message)) && /404|42P01|does not exist|PGRST20/.test(String(e && e.message))
  ? "у базі немає таблиць входу — виконай supabase-v146.sql" : "");

async function saveMember(E, uid, u, state) {
  const now = new Date().toISOString();
  const row = { uid, status: state.state === "in" ? (state.status || "member") : (state.status === "kicked" ? "kicked" : "left"), checked_at: now, last_seen: now };
  if (u) { row.name = nameOf(u); row.username = clean(u.username, 40); }
  await upsert(E, "tg_members", [row], "uid");
}
// Людина вийшла з групи: її телефони більше не отримують сповіщень.
async function dropDevices(E, uid) {
  let rows = [];
  try { rows = await db(E, "GET", `tg_devices?uid=eq.${uid}&select=endpoint`); } catch { rows = []; }
  let n = 0;
  for (const r of rows || []) {
    try { await rpc(E, "push_unsubscribe", { p_endpoint: r.endpoint }, E.anon || E.svc); n++; } catch { /* наступного разу */ }
  }
  if ((rows || []).length) { try { await db(E, "DELETE", `tg_devices?uid=eq.${uid}`); } catch { /* */ } }
  return n;
}

// ── Тексти бота (мова — з Telegram людини) ──────────────────────────
const BOT_TXT = {
  uk: {
    ok: (n) => `✅ Готово, ${n}! Повертайся в застосунок Tropa Club — вхід уже відкрито.`,
    open: "Відкрити Tropa Club",
    out: (g) => `Застосунок Tropa Club — лише для учасників групи ${g}. Приєднайся до групи, а тоді знову натисни «Увійти через Telegram» у застосунку.`,
    join: "Приєднатися до групи",
    old: "Це посилання для входу застаріло. Повернись у застосунок Tropa Club і натисни «Увійти через Telegram» ще раз.",
    err: "Зараз не вдалося перевірити групу. Спробуй за хвилину або напиши організатору.",
    hello: "Привіт! Це бот застосунку Tropa Club. Щоб увійти, відкрий застосунок і натисни «Увійти через Telegram».",
  },
  en: {
    ok: (n) => `✅ Done, ${n}! Go back to the Tropa Club app — you're signed in.`,
    open: "Open Tropa Club",
    out: (g) => `The Tropa Club app is only for members of the group ${g}. Join the group, then tap “Sign in with Telegram” in the app again.`,
    join: "Join the group",
    old: "This sign-in link has expired. Go back to the Tropa Club app and tap “Sign in with Telegram” again.",
    err: "Couldn't check the group right now. Try again in a minute or write to the organiser.",
    hello: "Hi! This is the Tropa Club app bot. To sign in, open the app and tap “Sign in with Telegram”.",
  },
  ru: {
    ok: (n) => `✅ Готово, ${n}! Возвращайся в приложение Tropa Club — вход уже открыт.`,
    open: "Открыть Tropa Club",
    out: (g) => `Приложение Tropa Club — только для участников группы ${g}. Вступи в группу, а затем снова нажми «Войти через Telegram» в приложении.`,
    join: "Вступить в группу",
    old: "Эта ссылка для входа устарела. Вернись в приложение Tropa Club и нажми «Войти через Telegram» ещё раз.",
    err: "Сейчас не удалось проверить группу. Попробуй через минуту или напиши организатору.",
    hello: "Привет! Это бот приложения Tropa Club. Чтобы войти, открой приложение и нажми «Войти через Telegram».",
  },
};
const langOf = (u) => { const l = String((u && u.language_code) || "uk").slice(0, 2).toLowerCase(); return l === "en" ? "en" : l === "ru" || l === "be" || l === "kk" ? "ru" : "uk"; };
const groupLink = (g) => (/^@[A-Za-z0-9_]{4,}$/.test(g) ? `https://t.me/${g.slice(1)}` : "");
const reply = (chatId, text, buttons) => ({
  method: "sendMessage", chat_id: chatId, text,
  ...(buttons && buttons.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : {}),
});

// ── Webhook: «Start» у боті й вихід із групи ────────────────────────
export async function onUpdate(E, C, up) {
  // Вихід / повернення в групу (бот має бути адміністратором групи).
  if (up && up.chat_member) {
    const cm = up.chat_member;
    const chat = cm.chat || {};
    const ours = String(chat.id) === C.group || (chat.username && `@${String(chat.username).toLowerCase()}` === C.group.toLowerCase());
    const u = cm.new_chat_member && cm.new_chat_member.user;
    if (!ours || !u || !u.id || u.is_bot) return null;
    const st = String(cm.new_chat_member.status || "");
    const inside = IN.includes(st) || (st === "restricted" && cm.new_chat_member.is_member === true);
    try {
      await saveMember(E, u.id, u, { state: inside ? "in" : "out", status: inside ? st : (st === "kicked" ? "kicked" : "left") });
      if (!inside) await dropDevices(E, u.id);
    } catch { /* звірка годинника наздожене */ }
    return null;
  }
  const msg = up && up.message;
  if (!msg || !msg.chat || msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return null;
  const text = String(msg.text || "").trim();
  if (!/^\/start\b/.test(text)) return null;
  const L = BOT_TXT[langOf(msg.from)];
  const nonce = text.split(/\s+/)[1] || "";
  if (!NONCE_RE.test(nonce)) return reply(msg.chat.id, L.hello, [{ text: L.open, url: appUrl("/") }]);
  let row = null;
  try { row = ((await db(E, "GET", `tg_logins?nonce=eq.${encodeURIComponent(nonce)}&select=*`)) || [])[0] || null; } catch { row = null; }
  const age = row ? (Date.now() - new Date(row.created_at).getTime()) / 60000 : Infinity;
  if (!row || age > NONCE_MIN) return reply(msg.chat.id, L.old, [{ text: L.open, url: appUrl("/") }]);
  const uid = msg.from.id;
  const ms = await memberState(C.bot, C.group, uid);
  if (ms.state === "error") {
    try { await db(E, "PATCH", `tg_logins?nonce=eq.${encodeURIComponent(nonce)}`, { state: "error", reason: clean(ms.why, 120), done_at: new Date().toISOString() }); } catch { /* */ }
    return reply(msg.chat.id, L.err);
  }
  try { await saveMember(E, uid, msg.from, ms); } catch { /* квиток однаково видамо */ }
  const ok = ms.state === "in";
  try {
    await db(E, "PATCH", `tg_logins?nonce=eq.${encodeURIComponent(nonce)}`, { state: ok ? "ok" : "no", uid, name: nameOf(msg.from), reason: ok ? "" : ms.status || "out", done_at: new Date().toISOString() });
  } catch {
    return reply(msg.chat.id, L.err);
  }
  // Без кнопки-посилання: на телефоні вона відкрила б сайт у браузері, а
  // не встановлений застосунок, і людина лишилась би не там. Застосунок
  // сам побачить вхід, щойно до нього повернутись.
  if (ok) return reply(msg.chat.id, L.ok(nameOf(msg.from)));
  const jl = groupLink(C.group);
  return reply(msg.chat.id, L.out(C.group.startsWith("@") ? C.group : "Tropa Club"), jl ? [{ text: L.join, url: jl }] : []);
}

// ── Квиток → чи пускати ─────────────────────────────────────────────
export async function checkToken(E, C, token) {
  const p = readToken(C.sess, token);
  if (!p) return { ok: false, reason: "bad" };
  if (p.admin) return { ok: true, admin: true, name: p.name };
  let row = null;
  try { row = ((await db(E, "GET", `tg_members?uid=eq.${p.uid}&select=*`)) || [])[0] || null; }
  catch (e) { return { ok: true, name: p.name, soft: "база не відповіла" }; }   // не зачиняємо через збій
  const fresh = row && (Date.now() - new Date(row.checked_at).getTime()) / 3600000 < RECHECK_H;
  if (row && fresh) {
    if (!isIn(row.status)) return { ok: false, reason: "left" };
    db(E, "PATCH", `tg_members?uid=eq.${p.uid}`, { last_seen: new Date().toISOString() }).catch(() => {});
    return { ok: true, name: row.name || p.name };
  }
  const ms = await memberState(C.bot, C.group, p.uid);
  if (ms.state === "error") {
    // Telegram мовчить — віримо останньому відомому стану.
    if (row && !isIn(row.status)) return { ok: false, reason: "left" };
    return { ok: true, name: (row && row.name) || p.name, soft: ms.why };
  }
  try { await saveMember(E, p.uid, null, ms); } catch { /* */ }
  if (ms.state === "out") { await dropDevices(E, p.uid).catch(() => 0); return { ok: false, reason: "left" }; }
  return { ok: true, name: (row && row.name) || p.name };
}

// ── Щоденна звірка (годинник) ───────────────────────────────────────
export async function sweep(E, C) {
  const before = new Date(Date.now() - RECHECK_H * 3600000).toISOString();
  const out = { checked: 0, left: 0, errors: 0, pushOff: 0 };
  let rows = [];
  try {
    rows = await db(E, "GET", `tg_members?status=in.(creator,administrator,member,restricted)&checked_at=lt.${encodeURIComponent(before)}&select=uid,status&order=checked_at.asc&limit=${SWEEP_LIMIT}`);
  } catch (e) { return { ...out, error: setupHint(e) || String(e.message).slice(0, 120) }; }
  // По вісім одночасно: 40 людей — за секунду-дві, а не за десять.
  const list = rows || [];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async (r) => {
      const ms = await memberState(C.bot, C.group, r.uid);
      if (ms.state === "error") { out.errors++; return; }
      out.checked++;
      try { await saveMember(E, r.uid, null, ms); } catch { out.errors++; return; }
      if (ms.state === "out") { out.left++; out.pushOff += await dropDevices(E, r.uid).catch(() => 0); }
    }));
  }
  // Старі коди входу прибираємо: потрібні лише пів години.
  try { await db(E, "DELETE", `tg_logins?created_at=lt.${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}`); } catch { /* */ }
  return out;
}

async function pushLists(E) {
  const all = await rpc(E, "push_list", { p_secret: process.env.PUSH_SECRET, p_only_admin: false }, E.anon || E.svc);
  const adm = await rpc(E, "push_list", { p_secret: process.env.PUSH_SECRET, p_only_admin: true }, E.anon || E.svc).catch(() => []);
  return { all: (all || []).map((x) => x.endpoint).filter(Boolean), admin: new Set((adm || []).map((x) => x.endpoint)) };
}

export default async function handler(req, res) {
  const C = env();
  const E = { url: C.url, svc: C.svc, anon: C.anon };
  const wanted = Boolean(C.bot) && !C.off;

  // Telegram шле оновлення з секретним заголовком — лише його й слухаємо.
  const hdr = String((req.headers && (req.headers["x-telegram-bot-api-secret-token"] || req.headers["X-Telegram-Bot-Api-Secret-Token"])) || "");
  if (req.method === "POST" && hdr) {
    if (!C.bot || hdr !== hookSecret(C.bot)) { res.status(403).json({ error: "bad hook" }); return; }
    let ans = null;
    try { ans = await onUpdate(E, C, req.body || {}); } catch { ans = null; }
    res.status(200).json(ans || {});
    return;
  }

  if (req.method === "GET") {
    const rd = wanted ? await ready(C, E) : null;
    const rep = { "версія": VERSION, "перевірка входу": !wanted ? (C.bot ? "вимкнена (TELEGRAM_GATE=off)" : "вимкнена — немає TELEGRAM_BOT_TOKEN у Vercel; застосунок відкритий для всіх") : rd.ok ? "увімкнена" : `ще не діє — ${rd.why}; поки застосунок відкритий для всіх`, "група": C.group };
    if (C.bot) {
      const me = await botMe(C.bot);
      rep["бот"] = me ? `@${me.username}` : "токен не приймається — перевір TELEGRAM_BOT_TOKEN";
      if (me) {
        const g = await tgCall(C.bot, "getChat", { chat_id: C.group }, 6000);
        rep["група знайдена"] = g && g.ok ? `так — «${clean(g.result.title, 60)}»` : `ні — бот не бачить ${C.group}: додай бота в групу (${clean(g && g.description, 80)})`;
        const bm = await tgCall(C.bot, "getChatMember", { chat_id: C.group, user_id: me.id }, 6000);
        const st = bm && bm.ok && bm.result ? bm.result.status : "";
        rep["бот — адміністратор групи"] = st === "administrator" ? "так" : st ? `ні (${st}) — зроби бота адміністратором: без цього Telegram може не відповідати про учасників` : "невідомо";
        const h = await ensureHook(C.bot);
        rep["webhook"] = h.ok ? (h.set ? "щойно встановлено" : "так") : `ні — ${h.why}`;
      }
    }
    try {
      const m = await db(E, "GET", "tg_members?select=status");
      rep["увійшло людей"] = (m || []).filter((x) => isIn(x.status)).length;
      rep["вийшли з групи"] = (m || []).filter((x) => !isIn(x.status)).length;
    } catch (e) { rep["база"] = setupHint(e) || `не відповіла: ${String(e.message).slice(0, 100)}`; }
    res.status(200).json(rep);
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "лише POST" }); return; }

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const action = String(body.action || "");
  try {
    // Для дій застосунку перевірка діє, лише коли все налаштовано (ready).
    const needReady = ["status", "check", "begin", "poll", "link", "pin"].includes(action);
    const rd = wanted && needReady ? await ready(C, E) : null;
    const gate = wanted && (!needReady || Boolean(rd && rd.ok));
    if (action === "status") { res.status(200).json({ gate, group: C.group, join: groupLink(C.group) }); return; }

    if (action === "check") {
      if (!gate) { res.status(200).json({ gate: false, ok: true }); return; }
      const r = await checkToken(E, C, body.token);
      res.status(200).json({ gate: true, group: C.group, join: groupLink(C.group), ...r });
      return;
    }

    if (action === "begin") {
      if (!gate) { res.status(200).json({ gate: false }); return; }
      const me = await botMe(C.bot);
      if (!me) { res.status(502).json({ gate: true, error: "бот Telegram зараз не відповідає — спробуй за хвилину", code: "bot" }); return; }
      // Webhook перевіряємо раз на запуск функції: без нього «Start» у
      // боті нікуди б не дійшов.
      if (!HOOK_DONE) { const h = await ensureHook(C.bot).catch(() => ({ ok: false })); HOOK_DONE = Boolean(h && h.ok); }
      const nonce = b64u(crypto.randomBytes(18));
      try { await db(E, "POST", "tg_logins", [{ nonce }], { Prefer: "return=minimal" }); }
      catch (e) { res.status(500).json({ gate: true, error: setupHint(e) || "база не відповіла — спробуй ще раз", code: "db" }); return; }
      res.status(200).json({ gate: true, nonce, bot: me.username, group: C.group, join: groupLink(C.group), link: `https://t.me/${me.username}?start=${nonce}`, ttlMin: NONCE_MIN });
      return;
    }

    if (action === "poll") {
      if (!gate) { res.status(200).json({ gate: false }); return; }
      const nonce = String(body.nonce || "");
      if (!NONCE_RE.test(nonce)) { res.status(400).json({ gate: true, state: "expired" }); return; }
      let row = null;
      try { row = ((await db(E, "GET", `tg_logins?nonce=eq.${encodeURIComponent(nonce)}&select=*`)) || [])[0] || null; }
      catch { res.status(200).json({ gate: true, state: "wait" }); return; }
      const age = row ? (Date.now() - new Date(row.created_at).getTime()) / 60000 : Infinity;
      if (!row || age > NONCE_MIN + 30) { res.status(200).json({ gate: true, state: "expired" }); return; }
      if (row.state === "ok" && row.uid) {
        res.status(200).json({ gate: true, state: "ok", name: row.name || "", token: signToken(C.sess, { u: Number(row.uid), n: row.name || "", t: Math.floor(Date.now() / 1000) }) });
        return;
      }
      if (row.state === "no") { res.status(200).json({ gate: true, state: "no", group: C.group, join: groupLink(C.group) }); return; }
      if (row.state === "error") { res.status(200).json({ gate: true, state: "error", why: row.reason || "" }); return; }
      res.status(200).json({ gate: true, state: age > NONCE_MIN ? "expired" : "wait" });
      return;
    }

    if (action === "link") {
      if (!gate) { res.status(200).json({ gate: false }); return; }
      const p = readToken(C.sess, body.token);
      const endpoint = String(body.endpoint || "").trim();
      if (!p || !/^https:\/\/\S{10,600}$/.test(endpoint)) { res.status(400).json({ error: "bad" }); return; }
      if (p.admin) { res.status(200).json({ ok: true, admin: true }); return; }
      await upsert(E, "tg_devices", [{ endpoint, uid: p.uid, linked_at: new Date().toISOString() }], "endpoint");
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "pin") {
      if (!gate) { res.status(200).json({ gate: false }); return; }
      if (!(await pinOk(E, body.pin))) { res.status(403).json({ error: "PIN не підійшов", code: "pin" }); return; }
      const now = Math.floor(Date.now() / 1000);
      res.status(200).json({ ok: true, token: signToken(C.sess, { u: 0, n: "організатор", t: now, a: 1, e: now + ADMIN_DAYS * 86400 }) });
      return;
    }

    if (action === "admin" || action === "cleanup") {
      if (!(await pinOk(E, body.pin))) { res.status(403).json({ error: "потрібен PIN організатора", code: "pin" }); return; }
      const rdA = wanted ? await ready(C, E) : null;
      const out = { gate: wanted && Boolean(rdA && rdA.ok), configured: Boolean(C.bot), off: C.off, notReady: rdA && !rdA.ok ? rdA.why : "", group: C.group, version: VERSION };
      if (C.bot) { const me = await botMe(C.bot); out.bot = me ? me.username : ""; }
      let members = [], devices = [];
      try {
        members = (await db(E, "GET", "tg_members?select=uid,status,name,last_seen&order=last_seen.desc")) || [];
        devices = (await db(E, "GET", "tg_devices?select=endpoint,uid")) || [];
      } catch (e) { out.dbError = setupHint(e) || String(e.message).slice(0, 120); }
      const leftIds = new Set(members.filter((m) => !isIn(m.status)).map((m) => Number(m.uid)));
      out.members = members.length - leftIds.size;
      out.left = leftIds.size;
      out.recent = members.filter((m) => !leftIds.has(Number(m.uid))).slice(0, 5).map((m) => clean(m.name, 40));
      let lists = null;
      try { lists = await pushLists(E); } catch (e) { out.pushError = String(e.message).slice(0, 120); }
      if (lists) {
        const linked = new Set(devices.filter((d) => !leftIds.has(Number(d.uid))).map((d) => d.endpoint));
        const unlinked = lists.all.filter((ep) => !linked.has(ep) && !lists.admin.has(ep));
        out.pushTotal = lists.all.length;
        out.pushLinked = lists.all.filter((ep) => linked.has(ep)).length;
        out.pushAdmin = lists.all.filter((ep) => lists.admin.has(ep)).length;
        out.pushUnlinked = unlinked.length;
        if (action === "cleanup") {
          if (out.dbError) { res.status(500).json({ error: out.dbError }); return; }
          // Поки вхід не діє, ніхто не може прив'язати телефон — «без входу»
          // тоді всі. Вимкнули б сповіщення всім учасникам.
          if (!out.gate) { res.status(409).json({ error: "вхід через Telegram ще не діє — поки він не працює, вимикати сповіщення не можна (вимкнулись би в усіх)", code: "gate" }); return; }
          let removed = 0;
          for (const ep of unlinked) {
            try { await rpc(E, "push_unsubscribe", { p_endpoint: ep }, E.anon || E.svc); removed++; } catch { /* наступного разу */ }
          }
          out.removed = removed;
          out.pushUnlinked = unlinked.length - removed;
          out.pushTotal -= removed;
        }
      }
      res.status(200).json(out);
      return;
    }

    if (action === "sweep") {
      if (!process.env.CRON_SECRET || String(body.secret || "") !== process.env.CRON_SECRET) { res.status(403).json({ error: "bad secret" }); return; }
      if (!wanted) { res.status(200).json({ gate: false, note: "перевірка входу вимкнена" }); return; }
      res.status(200).json({ gate: true, ...(await sweep(E, C)) });
      return;
    }

    res.status(400).json({ error: "невідома дія", code: "action" });
  } catch (e) {
    res.status(500).json({ error: setupHint(e) || String((e && e.message) || e).slice(0, 160), code: "server" });
  }
}
