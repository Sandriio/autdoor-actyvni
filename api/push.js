// ═══ Tropa Club · api/push.js · ВЕРСІЯ p3 ═══
// p3 — сповіщення учасникові, коли організатор прийняв чи відхилив
//      заявку (режим notifyDecision; потрібен supabase-v134.sql).
//      Сповіщення організаторові про заявку — мовою його телефона.
// p2 — кожне сповіщення несе адресу, куди вести після натискання:
//      заявка → вхід організатора й список записів цієї поїздки.
//      Приймаються лише адреси цього ж сайту.
// p1 — без версії в першому рядку; натискання завжди вело на головну.
// ═══════════════════════════════════════════════════════════════════
// Надсилання push-сповіщень
//
// БЕЗ ЗОВНІШНІХ БІБЛІОТЕК. Уся криптографія — на вбудованому в Node
// модулі crypto. Це свідомий вибір: інакше довелося б правити
// package.json, а зайва кома в JSON ламає всю збірку сайту.
// Формат шифрування перевірено проти еталонної бібліотеки web-push.
//
// ⚠️ ЗМІННІ СЕРЕДОВИЩА у Vercel (Settings → Environment Variables):
//   VAPID_PUBLIC_KEY   — публічний ключ (він же вшитий у застосунок)
//   VAPID_PRIVATE_KEY  — приватний ключ, НІКОЛИ не потрапляє в код
//   VAPID_SUBJECT      — mailto: з вашою поштою (вимога стандарту)
//   PUSH_SECRET        — спільне слово, щоб надсилати могли лише свої
//   SUPABASE_URL       — адреса проєкту Supabase
//   SUPABASE_ANON_KEY  — публічний ключ Supabase
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");

// Куди вести після натискання на сповіщення. Лише шлях цього ж сайту,
// що починається з однієї косої: «/?trip=t123&to=booking». Повна адреса
// чужого сайту чи «//інший.сайт» перетворюються на головну.
const safeUrl = (u) => (typeof u === "string" && /^\/(?![\/\\])/.test(u) ? u.slice(0, 300) : "/");
// Номер поїздки для адреси. Лише службові знаки прибираємо — сам номер
// застосунок однаково звіряє зі списком поїздок.
const cleanId = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);

// ── Мова й тексти ─────────────────────────────────────────────────────
// Кожен телефон отримує сповіщення мовою, обраною в застосунку: вона
// зберігається в підписці й оновлюється, коли людина перемикає мову.
// Застосунок знає три мови; незнайому — англійською, бо її зрозуміє
// більше людей, ніж українську.
const LANGS = ["uk", "en", "ru"];
const langOf = (v) => {
  const l = String(v || "uk").slice(0, 2).toLowerCase();
  return LANGS.includes(l) ? l : "en";
};
// Поле поїздки буває рядком (лише українською) або {uk, en, ru}. Буває й
// рядок із JSON усередині — так його віддає база, коли бере поле як текст.
const tx = (v, lang) => {
  if (v == null) return "";
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{")) { try { return tx(JSON.parse(t), lang); } catch (e) { /* звичайний текст */ } }
    return v;
  }
  if (typeof v === "object") return String(v[lang] || v.uk || v.en || v.ru || "");
  return String(v);
};
// Дні тижня — ті самі, що в застосунку (App.jsx → WEEKDAYS).
const WEEKDAYS = {
  uk: ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  ru: ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"],
};
// Дата поїздки мовою отримувача: «Субота, 03.10.26» — як на картці.
const whenOf = (trip, lang) => {
  const m = String((trip && trip.date) || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
    return `${(WEEKDAYS[lang] || WEEKDAYS.uk)[d.getUTCDay()]}, ${m[3]}.${m[2]}.${m[1].slice(2)}`;
  }
  return tx(trip && trip.dateLabel, lang);
};
// «(2 особи)» — з правильним закінченням.
const peopleOf = (n, lang) => {
  if (lang === "en") return `${n} people`;
  if (lang === "ru") return `${n} чел.`;
  const d = n % 10, h = n % 100;
  return `${n} ${d >= 2 && d <= 4 && (h < 12 || h > 14) ? "особи" : "осіб"}`;
};
// Організаторові: нова заявка чекає на нього.
const BOOKING_MSG = {
  uk: (who, title, n) => ({ title: "Новий запис — потрібне підтвердження", body: `${who} записався на «${title}». Очікує підтвердження: ${n}.` }),
  en: (who, title, n) => ({ title: "New sign-up — approval needed", body: `${who} signed up for “${title}”. Waiting for approval: ${n}.` }),
  ru: (who, title, n) => ({ title: "Новая запись — нужно подтверждение", body: `${who} записался на «${title}». Ждут подтверждения: ${n}.` }),
};
// Учасникові: рішення організатора. w — дата, n — назва поїздки.
const DECISION_MSG = {
  confirmed: {
    uk: (w, n) => ({ title: "Заявку прийнято", body: `Вашу заявку на вступ у групу до ${w} ${n} прийнято.` }),
    en: (w, n) => ({ title: "Request accepted", body: `Your request to join the trip to ${n} on ${w} has been accepted.` }),
    ru: (w, n) => ({ title: "Заявка принята", body: `Ваша заявка на вступление в группу до ${w} ${n} принята.` }),
  },
  declined: {
    uk: (w, n) => ({ title: "Заявку відхилено", body: `Вашу заявку на вступ у групу до ${w} ${n} відхилено. Зверніться до організатора.` }),
    en: (w, n) => ({ title: "Request declined", body: `Your request to join the trip to ${n} on ${w} has been declined. Please contact the organiser.` }),
    ru: (w, n) => ({ title: "Заявка отклонена", body: `Ваша заявка на вступление в группу до ${w} ${n} отклонена. Обратитесь к организатору.` }),
  },
};
// Поїздка — назва й дата для тексту. Чернеток тут не буває: на них не
// записуються, тож вистачає публічного читання.
async function loadTrip(id) {
  try {
    const key = process.env.SUPABASE_ANON_KEY;
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/trips?id=eq.${encodeURIComponent(id)}&select=data`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return {};
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0] && rows[0].data) || {};
  } catch (e) { return {}; }
}

// Скорочений HKDF: нам завжди потрібен рівно один блок.
function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  return crypto.createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, len);
}

// Шифрування вмісту сповіщення ключами конкретного пристрою (RFC 8291).
// Сервер Google чи Apple передає його, не маючи змоги прочитати.
function encryptPayload(uaPublicB64, authB64, payload) {
  const uaPublic = fromB64u(uaPublicB64);
  const auth = fromB64u(authB64);

  const ec = crypto.createECDH("prime256v1");
  ec.generateKeys();
  const asPublic = ec.getPublicKey();
  const shared = ec.computeSecret(uaPublic);

  const ikm = hkdf(auth, shared, Buffer.concat([
    Buffer.from("WebPush: info\0"), uaPublic, asPublic,
  ]), 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // 0x02 — позначка «це останній запис», вимога формату.
  const plain = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Підпис VAPID: доводить push-серверу, що надсилає саме наш застосунок.
function vapidHeader(audience) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const sub = process.env.VAPID_SUBJECT || "mailto:autdoor.actyvni@gmail.com";
  const p = fromB64u(pub);
  const key = crypto.createPrivateKey({
    key: {
      kty: "EC", crv: "P-256",
      d: fromB64u(priv).toString("base64url"),
      x: p.subarray(1, 33).toString("base64url"),
      y: p.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 43200, // 12 годин
    sub,
  }));
  const data = `${head}.${body}`;
  // ieee-p1363 — «сирий» формат підпису з 64 байтів. Стандартний для
  // Node формат DER push-сервери не приймають.
  const sig = crypto.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return { Authorization: `vapid t=${data}.${b64u(sig)}, k=${pub}` };
}

async function sendOne(sub, payload) {
  const url = new URL(sub.endpoint);
  const body = encryptPayload(sub.p256dh, sub.auth, payload);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      ...vapidHeader(url.origin),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      // Висока терміновість. При «normal» телефон має право притримати
      // сповіщення до виходу з режиму сну — на Android це легко дає
      // десятки хвилин затримки вже ПІСЛЯ того, як годинник спрацював.
      // «high» будить пристрій одразу. Для кількох сповіщень на поїздку
      // різниця в батареї непомітна.
      Urgency: "high",
    },
    body,
  });
  // 404 і 410 означають, що підписка мертва: людина зняла дозвіл або
  // видалила застосунок. Такі прибираємо, інакше вони накопичуються
  // й уповільнюють кожну наступну розсилку.
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}

async function sb(fn, body) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  try {
    // msgs — тексти по мовах: { uk: {title, body}, en: {...}, ru: {...} }.
    // Кожен пристрій отримує свою мову: вона збережена в підписці ще
    // при вмиканні сповіщень. Старий формат title/body теж працює.
    // Два способи довести право надсилати:
    //   secret — для годинника (push-cron), він серверний і в код не потрапляє;
    //   pin    — для застосунку в руках організатора; перевіряється в базі.
    // Раніше застосунок надсилав secret, і той лежав у відкритому коді:
    // будь-хто міг розіслати сповіщення на всі телефони.
    const { secret, pin, title, body, url, tag, msgs, notifyBooking, notifyDecision, onlyAdmin } = req.body || {};

    // Окремий режим: сповістити ЛИШЕ організатора про новий запис.
    // Авторизації тут немає — її замінює ключ самого запису. Він
    // видається в момент запису й доводить, що запис справді щойно
    // створено. Без цього адресою можна було б засипати організатора
    // вигаданими сповіщеннями.
    if (notifyBooking && notifyBooking.id && notifyBooking.token) {
      let info;
      try {
        info = await sb("booking_notify", { p_id: notifyBooking.id, p_token: notifyBooking.token });
      } catch (e) {
        res.status(403).json({ error: "bad booking" });
        return;
      }
      if (!info || info.status !== "pending") { res.status(200).json({ sent: 0, note: "no approval needed" }); return; }
      // Текст — мовою телефона організатора, як і решта сповіщень.
      const msgFor = (lang) => {
        const n = Number(info.people) || 1;
        const who = `${info.name}${n > 1 ? ` (${peopleOf(n, lang)})` : ""}`;
        return BOOKING_MSG[lang](who, tx(info.title, lang), info.pending);
      };
      const subs = await sb("push_list", { p_secret: process.env.PUSH_SECRET, p_only_admin: true });
      if (!subs || subs.length === 0) { res.status(200).json({ sent: 0, note: "no admin device" }); return; }
      // Натискання веде організатора до вводу PIN, а після нього — у
      // список записів саме цієї поїздки. Номер поїздки дає база; якщо ні —
      // той, що надіслав застосунок разом із заявкою (він лише вказує, яку
      // сторінку відкрити, і нічого не дозволяє).
      const tripId = cleanId(info.trip_id || info.tripId || notifyBooking.tripId);
      const go = tripId ? `/?trip=${encodeURIComponent(tripId)}&to=manage` : "/?to=manage";
      let ok = 0;
      for (const sub of subs) {
        const payload = JSON.stringify({ ...msgFor(langOf(sub.lang)), url: go, tag: "booking" });
        try { if ((await sendOne(sub, payload)).ok) ok++; } catch (e) {}
      }
      res.status(200).json({ sent: ok });
      return;
    }

    // Окремий режим: сказати учасникові, що організатор прийняв чи
    // відхилив його заявку. Право — PIN організатора. Сповіщення йде
    // лише на телефон, з якого людина записувалась: застосунок прив'язує
    // запис до підписки цього телефона ключем запису (booking_link_push,
    // supabase-v134.sql). Немає прив'язки — немає кому надсилати, і
    // організатор бачить це у відповіді.
    if (notifyDecision && notifyDecision.id) {
      let okPin = false;
      try { okPin = Boolean(pin) && (await sb("check_pin", { pin })) === true; } catch (e) { okPin = false; }
      if (!okPin) { res.status(403).json({ error: "not allowed" }); return; }
      const id = cleanId(notifyDecision.id);
      const tripId = cleanId(notifyDecision.tripId);
      // Рішення беремо з бази, а не з запиту: сповіщення каже рівно те,
      // що там записано.
      const rows = await sb("trip_bookings", { p_trip_id: tripId, pin });
      const row = (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === id);
      if (!row) { res.status(200).json({ sent: 0, note: "booking not found" }); return; }
      const status = String(row.status || "");
      if (!DECISION_MSG[status]) { res.status(200).json({ sent: 0, note: "not decided" }); return; }
      let endpoint = null;
      try { endpoint = await sb("booking_push_endpoint", { p_id: id, pin }); }
      catch (e) { res.status(200).json({ sent: 0, note: "setup needed", error: String((e && e.message) || e).slice(0, 160) }); return; }
      if (!endpoint) { res.status(200).json({ sent: 0, note: "no device" }); return; }
      const subs = await sb("push_list", { p_secret: process.env.PUSH_SECRET, p_only_admin: false });
      const sub = (Array.isArray(subs) ? subs : []).find((x) => x.endpoint === endpoint);
      if (!sub) { res.status(200).json({ sent: 0, note: "notifications off" }); return; }
      // Одне сповіщення на одне рішення: подвійний дотик не надішле двох.
      const key = `dec:${id}:${status}`;
      let fresh = true;
      try { fresh = (await sb("push_log_claim", { p_key: key })) === true; } catch (e) { fresh = true; }
      if (!fresh) { res.status(200).json({ sent: 0, note: "already sent" }); return; }
      const lang = langOf(sub.lang);
      const trip = await loadTrip(tripId);
      const name = tx(trip.title, lang);
      const when = whenOf(trip, lang);
      const m = DECISION_MSG[status][lang](when, name);
      // Натискання веде на список учасників цієї поїздки.
      const payload = JSON.stringify({ ...m, url: `/?trip=${encodeURIComponent(tripId)}&to=guests`, tag: `booking-${id}` });
      let r = { ok: false, gone: false };
      try { r = await sendOne(sub, payload); } catch (e) { r = { ok: false, gone: false }; }
      if (r.gone) await sb("push_unsubscribe", { p_endpoint: endpoint }).catch(() => {});
      // Не дійшло — звільняємо ключ, щоб наступна спроба могла надіслати.
      if (!r.ok) await sb("push_log_release", { p_key: key, p_pin: pin }).catch(() => {});
      res.status(200).json(r.ok ? { sent: 1 } : { sent: 0, failed: 1, note: r.gone ? "notifications off" : "push failed" });
      return;
    }
    if (!process.env.VAPID_PRIVATE_KEY) {
      res.status(500).json({ error: "VAPID_PRIVATE_KEY not set in Vercel" });
      return;
    }
    let allowed = Boolean(secret) && secret === process.env.PUSH_SECRET;
    if (!allowed && pin) {
      try { allowed = (await sb("check_pin", { pin })) === true; }
      catch (e) { allowed = false; }
    }
    if (!allowed) {
      res.status(403).json({ error: "not allowed" });
      return;
    }
    const pack = (msgs && typeof msgs === "object") ? msgs : null;
    if (!title && !pack) { res.status(400).json({ error: "no title" }); return; }

    // Список підписок читається СЕРВЕРНИМ словом, а не тим, чим
    // авторизувався той, хто просить надіслати. Право надсилати вже
    // підтверджено вище — або словом годинника, або PIN у базі.
    // Раніше сюди підставлявся secret; коли застосунок перейшов на PIN,
    // secret став порожнім, і в базу йшов виклик без аргументів.
    const subs = await sb("push_list", {
      p_secret: process.env.PUSH_SECRET,
      p_only_admin: Boolean(onlyAdmin),
    });
    if (!subs || subs.length === 0) {
      res.status(200).json({ sent: 0, failed: 0, note: "no subscribers" });
      return;
    }

    // Текст готуємо для кожної мови один раз, а не для кожного пристрою.
    const payloadFor = (lang) => {
      const m = pack ? (pack[lang] || pack.uk || pack.en || Object.values(pack)[0]) : null;
      return JSON.stringify({
        title: (m && m.title) || title || "Tropa Club",
        body: (m && m.body) || body || "",
        url: safeUrl(url),
        tag: tag || "tropa",
      });
    };
    const cache = {};
    let sent = 0, failed = 0;
    const dead = [];

    // Розсилаємо пачками по 20: одночасно всім — і функція впирається
    // в ліміт часу, по одному — надто повільно.
    for (let i = 0; i < subs.length; i += 20) {
      const chunk = subs.slice(i, i + 20);
      const out = await Promise.all(chunk.map((s) => {
        const lang = langOf(s.lang);
        if (!cache[lang]) cache[lang] = payloadFor(lang);
        return sendOne(s, cache[lang]).catch(() => ({ ok: false, gone: false }));
      }));
      out.forEach((r, k) => {
        if (r.ok) sent++; else failed++;
        if (r.gone) dead.push(chunk[k].endpoint);
      });
    }

    for (const e of dead) {
      await sb("push_unsubscribe", { p_endpoint: e }).catch(() => {});
    }

    res.status(200).json({ sent, failed, removed: dead.length });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
