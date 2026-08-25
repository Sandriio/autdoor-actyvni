// ═══════════════════════════════════════════════════════════════════
// ГОДИННИК СПОВІЩЕНЬ
//
// Цю адресу смикає зовнішній безкоштовний сервіс cron-job.org кожні
// 15 хвилин. Функція дивиться на всі поїздки й вирішує, чи настав час
// якогось із запланованих сповіщень.
//
// ЧОМУ САМЕ ТАК
// Сама адреса нічого не памʼятає між викликами. Щоб те саме сповіщення
// не пішло чотири рази на годину, кожна відправка записується в базу
// (таблиця push_log). Перед надсиланням функція перевіряє, чи цей
// запис уже є. Це і є захист від повторів.
//
// ЧАС
// Сервер працює за UTC, а поїздки — за німецьким часом. Тому всі
// порівняння робимо у явному поясі Europe/Berlin: інакше влітку все
// приїжджало б на дві години раніше.
//
// ⚠️ Змінні середовища ті самі, що й у push.js, плюс CRON_SECRET.
// ═══════════════════════════════════════════════════════════════════

const TZ = "Europe/Berlin";

// Час у Берліні як прості числа, без зовнішніх бібліотек.
function berlinParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = {};
  f.formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}
// Скільки днів між двома датами у форматі РРРР-ММ-ДД.
function daysBetween(fromISO, toISO) {
  const a = new Date(`${fromISO}T00:00:00Z`).getTime();
  const b = new Date(`${toISO}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}
// Хвилини від півночі для тексту «08:15».
function minutesOf(hhmm) {
  const m = String(hhmm || "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const uk = (v) => (v == null ? "" : (typeof v === "string" ? v : (v.uk || v.en || v.ru || "")));

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

async function sendPush(origin, title, body, tag) {
  const r = await fetch(`${origin}/api/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env.PUSH_SECRET, title, body, url: "/", tag }),
  });
  return r.ok;
}

export default async function handler(req, res) {
  const secret = (req.query && req.query.secret) || (req.body && req.body.secret);
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(403).json({ error: "bad secret" });
    return;
  }

  const origin = `https://${req.headers.host}`;
  const now = new Date();
  const nowB = berlinParts(now);
  const nowMin = nowB.hour * 60 + nowB.minute;
  // Вікно спрацювання. Сервіс смикає нас раз на 15 хвилин, тож момент
  // «рівно 09:00» ловити не можна — беремо будь-який виклик у межах
  // 20 хвилин після потрібного часу. Повтори прибирає журнал.
  const WINDOW = 20;
  const dueAt = (h, m) => nowMin >= h * 60 + m && nowMin < h * 60 + m + WINDOW;

  let trips = [];
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/trips?select=id,data`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` },
    });
    trips = await r.json();
  } catch (e) {
    res.status(500).json({ error: "trips: " + String(e.message || e) });
    return;
  }

  const planned = [];

  for (const row of trips || []) {
    const tr = row.data || {};
    const id = row.id;
    const date = String(tr.date || "").trim();
    if (!date) continue;                       // без календарної дати нічого не плануємо
    const status = String(tr.status || "");
    if (status === "cancelled" || status === "done") continue;

    const title = uk(tr.title);
    const when = uk(tr.dateLabel) || date;
    const days = daysBetween(nowB.date, date); // 0 = сьогодні, 7 = за тиждень

    // ① За 7 днів о 09:00 — набір відкрито.
    if (days === 7 && dueAt(9, 0)) {
      planned.push({ key: `open:${id}`, tag: `trip-${id}`,
        title: "Відкрито запис у групу",
        body: `Запис у групу на ${when} — ${title} відкритий. Встигніть записатися!` });
    }

    // ② Напередодні о 22:00 — набір завершено.
    if (days === 1 && dueAt(22, 0)) {
      planned.push({ key: `close:${id}`, tag: `trip-${id}`,
        title: "Набір завершено",
        body: `Набір у групу на ${when} — ${title} завершений.` });
    }

    // ③ У день поїздки: місце зустрічі за 2 години до збору.
    if (days === 0) {
      const legs = Array.isArray(tr.journeys) && tr.journeys.length > 0
        ? (tr.journeys[0].legs || [])
        : (tr.legs || []);
      const firstLeg = legs.find((l) => l && String(l.fromTime || "").trim() !== "");
      const meetMin = minutesOf(tr.meetTime) || (firstLeg ? minutesOf(firstLeg.fromTime) : null);
      const place = uk(tr.meetingPoint) || (firstLeg ? firstLeg.from : "");
      if (meetMin != null) {
        const remindAt = meetMin - 120;
        const hh = String(Math.floor(meetMin / 60)).padStart(2, "0");
        const mm = String(meetMin % 60).padStart(2, "0");
        if (remindAt >= 0 && nowMin >= remindAt && nowMin < remindAt + WINDOW) {
          planned.push({ key: `meet:${id}`, tag: `trip-${id}`,
            title: "Нагадування про збір",
            body: `Місце зустрічі: ${place}, ${hh}:${mm}. Приходьте вчасно.` });
        }
      }
      // ④ У день поїздки о 21:00 — завершення.
      if (dueAt(21, 0)) {
        planned.push({ key: `end:${id}`, tag: `trip-${id}`,
          title: "Поїздка завершена",
          body: `Поїздка ${title} завершена. До нових зустрічей!` });
      }
    }
  }

  const sent = [], skipped = [];
  for (const p of planned) {
    // Журнал вирішує, чи це вже надсилалось. Спочатку позначаємо, потім
    // надсилаємо: якщо функцію обірве на півдорозі, краще не надіслати
    // взагалі, ніж надіслати те саме кілька разів.
    let fresh = false;
    try { fresh = await sb("push_log_claim", { p_key: p.key }); } catch (e) { skipped.push(p.key + ": log " + e.message); continue; }
    if (!fresh) { skipped.push(p.key + ": вже надсилалось"); continue; }
    const ok = await sendPush(origin, p.title, p.body, p.tag);
    (ok ? sent : skipped).push(p.key + (ok ? "" : ": помилка надсилання"));
  }

  res.status(200).json({ berlin: `${nowB.date} ${nowB.hour}:${String(nowB.minute).padStart(2, "0")}`, planned: planned.length, sent, skipped });
}
