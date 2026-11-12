// ═══ Tropa Club · api/tg.js · ВЕРСІЯ g4 ═══
// g4 (v149) — записуючи підписку на сповіщення (дія rpc, push_subscribe),
//      сервер каже телефону, чи база вже знала цю підписку (заголовок
//      X-Tropa-Push: known | new). Телефон, чию підписку сервер сповіщень
//      Apple чи Google оголосив недійсною (база її через це прибрала), досі
//      щоразу записував ту саму мертву адресу наново — і так і лишався без
//      сповіщень. Тепер, почувши «new» про підписку, яку вже записував,
//      застосунок створює на телефоні нову. Решта — без змін.
// g3 (v147) — двері більше не відчиняються через збій. Щойно хтось хоч раз
//      увійшов через бота, перевірка лишається ввімкненою за будь-якої
//      помилки (Telegram мовчить, бот втратив права, база не відповіла).
//      Відчинено лише тоді, коли бота немає, TELEGRAM_GATE=off, у базі немає
//      таблиць входу або ще ніхто ніколи не входив. Що саме зламалось —
//      видно в панелі організатора й за адресою /api/tg.
//      • Записи на поїздки й підписка на сповіщення — теж лише тут (дія rpc)
//        і лише з квитком: supabase-v147.sql забирає ці функції бази в
//        публічного ключа. Хто вийшов із групи, не запишеться, не побачить
//        списку учасників і не підпишеться на сповіщення в обхід застосунку.
//      • Квиток організатора за PIN діє 14 днів (було 180) і поновлюється
//        щоразу, як організатор входить у свій режим із PIN.
//      • Звірку квитків використовує й api/trains.js (функція admit).
//      • «Таблиць входу немає» — лише коли база прямо каже «таблицю не
//        знайдено» (404 з кодом PGRST205/42P01) і через бота ще ніхто не
//        входив; випадкове «404» у тексті помилки двері більше не відчиняє.
//      • Тестова збірка Vercel (preview) без діючого входу даних не віддає.
//      • Запис — лише на опубліковану поїздку; підписка й запис звіряють
//        квиток без хвилинної пам'яті; годинник вимикає телефони тих, хто
//        вийшов, навіть якщо їх устигли прив'язати знову.
//      • Поки є проблема з ботом, «вимкнути сповіщення без входу» не діє.
// g2 (v147) — поїздки тепер видає ЛИШЕ цей сервер (дія trips) і лише тим,
//      кого пускає вхід через Telegram. Пряме читання таблиці поїздок
//      публічним ключем закриває supabase-v147.sql — після нього людина,
//      що вийшла з групи, не дістане поїздок і в обхід застосунку.
//      Членство звіряється частіше: не рідше ніж раз на 6 годин (було 20).
//      Тимчасовий збій Telegram більше не відчиняє двері: якщо вхід уже
//      працював, він лишається чинним, поки Telegram не відповість знову.
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
//   trips { token }   — поїздки для учасника (g2)
//   rpc { fn, args, token } — функції бази від імені учасника: записи на
//                       поїздки й підписка на сповіщення (g3, перелік RPC_MEMBER)
// GET — перевірка налаштувань без секретів; заодно ставить webhook.
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";
import zlib from "zlib";

export const config = { maxDuration: 30 };
export const VERSION = "g4";

const TG = "https://api.telegram.org";
const NONCE_MIN = 30;            // код входу живе 30 хвилин
const RECHECK_H = 6;             // членство звіряємо, якщо минуло 6+ годин (g2; було 20)
const SWEEP_LIMIT = 40;          // скільки людей звіряє один виклик годинника (раз на годину)
const ADMIN_DAYS = 14;           // квиток організатора (за PIN) діє 14 днів; поновлюється з кожним входом за PIN (g3; було 180)
const IN = ["creator", "administrator", "member"];
// Функції бази, які застосунок кличе від імені учасника (g3). З
// supabase-v147.sql публічний ключ їх не кличе — лише цей сервер (дія rpc).
// Функції організатора з PIN тут немає: їх захищає сам PIN.
export const RPC_MEMBER = [
  "booked_counts", "trip_guests", "book_trip", "my_booking", "claim_booking",
  "cancel_booking", "update_booking", "booking_link_push", "push_subscribe",
];
// Дії, що лишають слід: квиток для них звіряємо без хвилинної пам'яті.
const LASTING = ["push_subscribe", "booking_link_push", "book_trip", "claim_booking"];
// Тестова збірка Vercel (preview) бачить ту саму базу. Без діючого входу
// через Telegram вона даних не віддає зовсім — інакше її адреса відкривала
// б усе кожному.
const PREVIEW_NO = { gate: true, ok: false, reason: "preview", error: "тестова збірка без входу через Telegram — дані не віддаються" };

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
      const now = Date.now() / 1000;
      if (!Number(p.e) || now > Number(p.e)) return null;
      // g3: не довше 14 днів від видачі — і для квитків, виданих ще на півроку.
      if (!Number(p.t) || now - Number(p.t) > ADMIN_DAYS * 86400 + 300) return null;
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
let BOT_NET = false;   // останній getMe не вдався через мережу, а не через токен
async function botMe(bot) {
  if (BOT_ME && BOT_ME.token === bot) return BOT_ME.me;
  const j = await tgCall(bot, "getMe", {}, 6000);
  BOT_NET = Boolean(j && j.net);
  if (j && j.ok && j.result) { BOT_ME = { token: bot, me: j.result }; return j.result; }
  return null;
}
let HOOK_DONE = false;
// Готовність. Поки вхід ще жодного разу не працював, перевірка вмикається
// лише коли все налаштовано — бот відповідає, бачить групу й він у ній
// адміністратор, webhook стоїть на цю адресу з чинним секретом, а в базі
// є таблиці входу. Так помилка в першому налаштуванні не зачиняє двері всім.
// g3: щойно хтось хоч раз увійшов через бота, перевірка лишається
// ввімкненою за будь-якої помилки — і тимчасової (Telegram мовчить), і
// сталої (бот втратив права, токен відкликали, webhook не ставиться).
// Хто вже увійшов, заходить, як і раніше; хто вийшов із групи — ні; нові
// входи чекають, доки організатор не виправить (причину видно в його
// панелі — поле problem — і за адресою /api/tg). Відчиняє двері лише
// TELEGRAM_GATE=off, відсутність бота чи таблиць входу у базі.
// Відповідь пам'ятаємо 10 хвилин (невдалу чи вимушену — 2).
let READY = null;
export function resetReady() { READY = null; BOT_ME = null; HOOK_DONE = false; SEEN.clear(); }
async function ready(C, E) {
  if (READY && READY.bot === C.bot && Date.now() - READY.at < (READY.ok ? 600000 : 120000)) return READY;
  let why = "";
  const me = await botMe(C.bot);
  if (!me) why = BOT_NET ? "Telegram не відповідає" : "бот не відповідає або токен неправильний — перевір TELEGRAM_BOT_TOKEN";
  if (!why) {
    const g = await tgCall(C.bot, "getChat", { chat_id: C.group }, 6000);
    if (!(g && g.ok)) why = g && g.net ? "Telegram не відповідає" : `бот не бачить групу ${C.group} — додай його в групу адміністратором`;
  }
  if (!why) {
    const bm = await tgCall(C.bot, "getChatMember", { chat_id: C.group, user_id: me.id }, 6000);
    const st = bm && bm.ok && bm.result ? String(bm.result.status || "") : "";
    if (st !== "administrator" && st !== "creator") why = bm && bm.net ? "Telegram не відповідає" : `бот не адміністратор групи ${C.group} — зроби його адміністратором (права можна не давати)`;
  }
  if (!why) {
    try { await db(E, "GET", "tg_logins?select=nonce&limit=1"); }
    catch (e) { why = setupHint(e) || "база не відповіла"; }
  }
  if (!why) {
    const h = await ensureHook(C.bot).catch(() => ({ ok: false, why: "Telegram не відповів", net: true }));
    if (!h.ok) why = `webhook не встановлено (${h.why || "невідомо чому"})`;
    else HOOK_DONE = true;
  }
  if (why) {
    // Чи вхід уже колись працював: готовність була на цьому сервері або
    // хтось уже входив через бота. Не вдалось навіть спитати базу — теж
    // вважаємо, що так: краще не пустити, ніж пустити всіх. Відчинено лише
    // тоді, коли таблиці людей справді немає або в ній порожньо.
    let used = Boolean(READY && READY.ok);
    if (!used) {
      try { const rows = await db(E, "GET", "tg_members?select=uid&limit=1"); used = Array.isArray(rows) && rows.length > 0; }
      catch (e) { used = !isMissingTable(e); }
    }
    if (used) { READY = { bot: C.bot, at: Date.now() - 480000, ok: true, why: "", assumed: why }; return READY; }
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
  if (info && info.net) return { ok: false, net: true, why: "Telegram не відповів" };
  const cur = info && info.ok && info.result ? info.result : null;
  const updates = cur && Array.isArray(cur.allowed_updates) ? cur.allowed_updates : [];
  if (cur && cur.url === want && updates.includes("chat_member")) return { ok: true, set: false };
  const j = await tgCall(bot, "setWebhook", { url: want, secret_token: hookSecret(bot), allowed_updates: ["message", "chat_member"], drop_pending_updates: true }, 8000);
  return j && j.ok ? { ok: true, set: true } : { ok: false, net: Boolean(j && j.net), why: clean(j && j.description, 120) };
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
// Таблиць входу справді немає (supabase-v146.sql не виконано): база
// відповідає 404 з кодом «таблицю не знайдено». Будь-який інший збій
// (тимчасова помилка, «404» десь у тексті відповіді) — не про налаштування.
const isMissingTable = (e) => Boolean(e) && e.status === 404
  && /tg_(members|logins|devices)/.test(`${e.message || ""} ${e.body || ""}`)
  && /"code"\s*:\s*"(PGRST205|42P01)"/.test(String(e.body || ""));
const setupHint = (e) => (isMissingTable(e) ? "у базі немає таблиць входу — виконай supabase-v146.sql" : "");

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
    if (!inside) seenDrop(u.id);
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
// Щойно перевірений квиток пам'ятаємо хвилину: застосунок, відкриваючись,
// питає кілька речей одразу (поїздки, місця, учасники), і зайвий раз
// питати базу ні до чого. Вихід із групи (chat_member) забуває відразу.
const SEEN = new Map();
const SEEN_MS = 60000;
const seenGet = (token) => {
  const h = SEEN.get(token);
  if (!h) return null;
  if (Date.now() - h.at > SEEN_MS) { SEEN.delete(token); return null; }
  return h.r;
};
const seenPut = (token, uid, r) => {
  if (SEEN.size >= 400) SEEN.delete(SEEN.keys().next().value);
  SEEN.set(token, { at: Date.now(), uid, r });
};
const seenDrop = (uid) => { for (const [k, v] of SEEN) if (v.uid === uid) SEEN.delete(k); };

// fresh — не брати з пам'яті: для дій, що лишають слід (підписка на
// сповіщення, запис), — щоб вихід із групи, який щойно обробив інший
// сервер, діяв відразу.
export async function checkToken(E, C, token, noMemo = false) {
  const p = readToken(C.sess, token);
  if (!p) return { ok: false, reason: "bad" };
  if (p.admin) return { ok: true, admin: true, name: p.name };
  const key = String(token);
  const hit = noMemo ? null : seenGet(key);
  if (hit) return hit;
  let row = null, dbDown = false;
  try { row = ((await db(E, "GET", `tg_members?uid=eq.${p.uid}&select=*`)) || [])[0] || null; }
  catch { dbDown = true; }
  const fresh = row && (Date.now() - new Date(row.checked_at).getTime()) / 3600000 < RECHECK_H;
  if (row && fresh) {
    if (!isIn(row.status)) return { ok: false, reason: "left" };
    db(E, "PATCH", `tg_members?uid=eq.${p.uid}`, { last_seen: new Date().toISOString() }).catch(() => {});
    const r = { ok: true, uid: p.uid, name: row.name || p.name };
    seenPut(key, p.uid, r);
    return r;
  }
  // Давно не звіряли, людини немає в базі або база не відповіла (g3: тоді
  // не пускаємо наосліп, а питаємо Telegram).
  const ms = await memberState(C.bot, C.group, p.uid);
  if (ms.state === "error") {
    // Telegram мовчить — віримо останньому відомому стану.
    if (row && !isIn(row.status)) return { ok: false, reason: "left" };
    return { ok: true, uid: p.uid, name: (row && row.name) || p.name, soft: dbDown ? "база й Telegram не відповіли" : ms.why };
  }
  if (!dbDown) { try { await saveMember(E, p.uid, null, ms); } catch { /* */ } }
  if (ms.state === "out") {
    seenDrop(p.uid);
    if (!dbDown) await dropDevices(E, p.uid).catch(() => 0);
    return { ok: false, reason: "left" };
  }
  const r = { ok: true, uid: p.uid, name: (row && row.name) || p.name };
  if (!dbDown) seenPut(key, p.uid, r);
  return r;
}

// Для інших серверів (api/trains.js): чи пускати запит із цим квитком до
// даних поїздок. Перевірки входу немає або вона ще не діє — пускаємо всіх.
export async function admit(token) {
  const C = env();
  if (!C.bot || C.off) return isProd() ? { ok: true, gate: false } : { ok: false, gate: true, reason: "preview" };
  const E = { url: C.url, svc: C.svc, anon: C.anon };
  const rd = await ready(C, E);
  if (!rd.ok) return isProd() ? { ok: true, gate: false } : { ok: false, gate: true, reason: "preview" };
  const who = await checkToken(E, C, token);
  return who.ok ? { ok: true, gate: true, admin: Boolean(who.admin) } : { ok: false, gate: true, reason: who.reason || "bad" };
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
      if (ms.state === "out") { seenDrop(r.uid); out.left++; out.pushOff += await dropDevices(E, r.uid).catch(() => 0); }
    }));
  }
  // Телефони тих, хто вже вийшов, але знову опинився прив'язаним (скажімо,
  // підписався в ту саму хвилину, коли виходив): вимикаємо й їх.
  try {
    const devs = (await db(E, "GET", "tg_devices?select=uid")) || [];
    const uids = [...new Set(devs.map((d) => Number(d.uid)).filter((u) => Number.isSafeInteger(u) && u > 0))].slice(0, 300);
    if (uids.length) {
      const gone = (await db(E, "GET", `tg_members?uid=in.(${uids.join(",")})&status=in.(left,kicked)&select=uid`)) || [];
      for (const g of gone) out.pushOff += await dropDevices(E, Number(g.uid)).catch(() => 0);
    }
  } catch { /* наступного разу */ }
  // Старі коди входу прибираємо: потрібні лише пів години.
  try { await db(E, "DELETE", `tg_logins?created_at=lt.${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}`); } catch { /* */ }
  return out;
}

async function pushLists(E) {
  const all = await rpc(E, "push_list", { p_secret: process.env.PUSH_SECRET, p_only_admin: false }, E.anon || E.svc);
  const adm = await rpc(E, "push_list", { p_secret: process.env.PUSH_SECRET, p_only_admin: true }, E.anon || E.svc).catch(() => []);
  return { all: (all || []).map((x) => x.endpoint).filter(Boolean), admin: new Set((adm || []).map((x) => x.endpoint)) };
}

// Відповідь JSON; великі (список поїздок) — стиснуто gzip: Vercel пропускає
// з функції не більше 4,5 МБ, а поїздок з роками більшає.
function sendJson(req, res, status, obj) {
  const raw = Buffer.from(JSON.stringify(obj));
  res.setHeader("Cache-Control", "no-store");
  const ae = String((req.headers && req.headers["accept-encoding"]) || "");
  if (raw.length > 20000 && /\bgzip\b/i.test(ae) && typeof res.end === "function") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.statusCode = status;
    res.end(zlib.gzipSync(raw));
    return;
  }
  res.status(status).json(obj);
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
    const rep = { "версія": VERSION, "перевірка входу": !wanted ? (C.bot ? "вимкнена (TELEGRAM_GATE=off)" : "вимкнена — немає TELEGRAM_BOT_TOKEN у Vercel; застосунок відкритий для всіх")
      : rd.ok ? (rd.assumed ? `увімкнена, але зараз проблема: ${rd.assumed}. Хто вже увійшов, заходить як і раніше; нові входи не спрацюють, доки це не виправиш` : "увімкнена")
      : `ще не діє — ${rd.why}; поки застосунок відкритий для всіх`, "група": C.group };
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
    const needReady = ["status", "check", "begin", "poll", "link", "pin", "trips", "rpc"].includes(action);
    const rd = wanted && needReady ? await ready(C, E) : null;
    const gate = wanted && (!needReady || Boolean(rd && rd.ok));
    if (action === "status") { res.status(200).json({ gate, group: C.group, join: groupLink(C.group) }); return; }

    // Поїздки для учасника (g2): лише опубліковані й не з архіву, і лише
    // з чинним квитком. Перевірки входу ще немає (бота не налаштовано) —
    // віддаємо всім, як раніше віддавала сама база.
    if (action === "trips") {
      if (!gate && !isProd()) { res.status(403).json(PREVIEW_NO); return; }
      let who = null;
      if (gate) {
        who = await checkToken(E, C, body.token);
        if (!who.ok) { res.status(403).json({ gate: true, ok: false, reason: who.reason || "bad", group: C.group, join: groupLink(C.group) }); return; }
      }
      let rows = null;
      try { rows = await db(E, "GET", "trips?select=data&order=updated_at.asc"); }
      catch (e) { res.status(502).json({ error: "база не відповіла — спробуй ще раз", code: "db" }); return; }
      const all = (rows || []).map((x) => x && x.data).filter((x) => x && typeof x === "object");
      const trips = all.filter((t) => t.draft !== true && t.archived !== true);
      const teasers = all.filter((t) => t.draft === true && t.archived !== true).map((t) => String(t.heroGradient || ""));
      sendJson(req, res, 200, { gate, ok: true, trips, teasers });
      return;
    }

    if (action === "check") {
      if (!gate) { res.status(200).json({ gate: false, ok: true }); return; }
      const { uid, ...r } = await checkToken(E, C, body.token);   // номер у Telegram телефону ні до чого
      res.status(200).json({ gate: true, group: C.group, join: groupLink(C.group), ...r });
      return;
    }

    // Функції бази від імені учасника (g3): записи на поїздки, список
    // учасників, підписка на сповіщення. Публічний ключ їх більше не кличе
    // (supabase-v147.sql) — лише цей сервер службовим ключем і лише для
    // того, кого пускає вхід через Telegram. Відповідь бази — як є: застосунок
    // читає її так само, як читав би напряму. Заголовок X-Tropa-Rpc каже
    // застосунку, що відповів саме цей сервер, а не старий.
    if (action === "rpc") {
      res.setHeader("X-Tropa-Rpc", VERSION);
      res.setHeader("Cache-Control", "no-store");
      const fn = String(body.fn || "");
      if (!RPC_MEMBER.includes(fn)) { res.status(400).json({ error: "ця функція — не через сервер", code: "fn" }); return; }
      const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
      if (!gate && !isProd()) { res.status(403).json(PREVIEW_NO); return; }
      let who = null;
      if (gate) {
        who = await checkToken(E, C, body.token, LASTING.includes(fn));
        if (!who.ok) { res.status(403).json({ gate: true, ok: false, reason: who.reason || "bad", group: C.group, join: groupLink(C.group) }); return; }
      }
      // Записатись можна лише на опубліковану поїздку. Службовий ключ бачить
      // і чернетки, тож сервер перевіряє це сам, хоч би як була написана
      // функція бази. Відповідь — та сама, що й «запис закрито».
      if (fn === "book_trip" || fn === "claim_booking") {
        let t = null;
        try { t = ((await db(E, "GET", `trips?id=eq.${encodeURIComponent(String(args.p_trip_id || ""))}&select=data`)) || [])[0]; }
        catch { res.status(502).json({ error: "база не відповіла — спробуй ще раз", code: "db" }); return; }
        const d = t && t.data;
        if (!d || d.draft === true || (fn === "book_trip" && d.archived === true)) {
          res.status(400).json({ code: "P0001", details: null, hint: null, message: "Zapys zakryto" });
          return;
        }
      }
      // g4: чи база вже знала цю підписку — питаємо ДО запису. Порожній
      // перелік чи помилку вважаємо «невідомо»: інакше збій у налаштуваннях
      // змусив би всі телефони перестворювати підписки.
      let pushWas = "";
      if (fn === "push_subscribe") {
        const ep0 = String(args.p_endpoint || "").trim();
        try {
          const all = await rpc(E, "push_list", { p_secret: process.env.PUSH_SECRET, p_only_admin: false }, E.anon || E.svc);
          if (ep0 && Array.isArray(all) && all.length > 0) pushWas = all.some((x) => x && x.endpoint === ep0) ? "known" : "new";
        } catch { pushWas = ""; }
      }
      let r = null, txt = "";
      try {
        r = await fetch(`${E.url}/rest/v1/rpc/${fn}`, {
          method: "POST", headers: { apikey: E.svc, Authorization: `Bearer ${E.svc}`, "Content-Type": "application/json" },
          body: JSON.stringify(args), signal: AbortSignal.timeout(10000),
        });
        txt = await r.text();
      } catch { res.status(502).json({ error: "база не відповіла — спробуй ще раз", code: "db" }); return; }
      // Нова підписка на сповіщення — одразу до людини: вийде з групи —
      // сповіщення на цей телефон вимкнуться самі.
      if (r.ok && fn === "push_subscribe" && who && who.ok && !who.admin && who.uid) {
        const ep = String(args.p_endpoint || "").trim();
        if (/^https:\/\/\S{10,600}$/.test(ep)) {
          try { await upsert(E, "tg_devices", [{ endpoint: ep, uid: who.uid, linked_at: new Date().toISOString() }], "endpoint"); } catch { /* застосунок прив'яже сам (link) */ }
        }
      }
      if (r.ok && pushWas) res.setHeader("X-Tropa-Push", pushWas);
      res.statusCode = r.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(txt);
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
      const out = { gate: wanted && Boolean(rdA && rdA.ok), configured: Boolean(C.bot), off: C.off, notReady: rdA && !rdA.ok ? rdA.why : "", problem: rdA && rdA.ok && rdA.assumed ? rdA.assumed : "", group: C.group, version: VERSION };
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
          // Поки є проблема з ботом, нові входи не працюють — учасники, які
          // саме зараз хотіли б увійти, лишились би без сповіщень.
          if (out.problem) { res.status(409).json({ error: `спершу виправ проблему: ${out.problem}`, code: "problem" }); return; }
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
