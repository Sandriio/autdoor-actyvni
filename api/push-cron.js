// ═══════════════════════════════════════════════════════════════════
// ГОДИННИК СПОВІЩЕНЬ
//
// Цю адресу смикає cron-job.org кожні 15 хвилин. Функція дивиться на
// всі поїздки й вирішує, чи настав час якогось зі сповіщень.
//
// ЗАХИСТ ВІД ПОВТОРІВ
// Сама адреса нічого не памʼятає між викликами, тож кожна відправка
// позначається унікальним ключем у таблиці push_log. Друга спроба з
// тим самим ключем нічого не робить.
//
// ЧАС
// Сервер працює за UTC, поїздки — за німецьким часом. Усі порівняння
// робимо в поясі Europe/Berlin, інакше влітку все приїжджало б на дві
// години раніше.
//
// МОВИ
// Кожне сповіщення готується трьома мовами й надсилається кожному
// пристрою тією, яку людина обрала в застосунку.
// ═══════════════════════════════════════════════════════════════════

const TZ = "Europe/Berlin";
const WINDOW = 20;        // хвилин на спрацювання: сервіс будить нас раз на 15
const LOW_SPOTS = 5;      // коли лишається стільки місць — попереджаємо

function berlinParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = {};
  f.formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const minutesOf = (v) => {
  const m = String(v || "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// Багатомовне поле поїздки: беремо потрібну мову, інакше українську.
const tx = (v, lang) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v[lang] || v.uk || v.en || v.ru || "";
};

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

async function sendPush(origin, msgs, tag) {
  const r = await fetch(`${origin}/api/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env.PUSH_SECRET, msgs, url: "/", tag }),
  });
  return r.ok;
}

// ── Тексти сповіщень ────────────────────────────────────────────────
// Кожен пункт віддає готовий набір { uk, en, ru }. Назва поїздки й дата
// беруться відповідною мовою, тож у німця не буде українського «Субота».
function build(kind, tr, extra) {
  const out = {};
  for (const lang of ["uk", "en", "ru"]) {
    const name = tx(tr.title, lang);
    const when = tx(tr.dateLabel, lang) || tr.date;
    out[lang] = ({
      open: {
        uk: { title: "Відкрито запис у групу", body: `Запис у групу на ${when} — ${name} відкритий. Встигніть записатися!` },
        en: { title: "Sign-up is open", body: `Sign-up for ${when} — ${name} is open. Grab your spot!` },
        ru: { title: "Открыта запись в группу", body: `Запись в группу на ${when} — ${name} открыта. Успейте записаться!` },
      },
      low: {
        uk: { title: "Лишається мало місць", body: `Залишилось всього ${extra} місць у набір до ${when} — ${name}!` },
        en: { title: "Only a few spots left", body: `Only ${extra} spots left for ${when} — ${name}!` },
        ru: { title: "Остаётся мало мест", body: `Осталось всего ${extra} мест в набор на ${when} — ${name}!` },
      },
      close: {
        uk: { title: "Набір завершено", body: `Набір у групу на ${when} — ${name} завершений.` },
        en: { title: "Sign-up closed", body: `Sign-up for ${when} — ${name} is closed.` },
        ru: { title: "Набор завершён", body: `Набор в группу на ${when} — ${name} завершён.` },
      },
      meet: {
        uk: { title: "Нагадування про збір", body: `Місце зустрічі: ${extra.place}, ${extra.time}. Приходьте вчасно.` },
        en: { title: "Meeting reminder", body: `Meeting point: ${extra.place}, ${extra.time}. Please be on time.` },
        ru: { title: "Напоминание о сборе", body: `Место встречи: ${extra.place}, ${extra.time}. Приходите вовремя.` },
      },
      end: {
        uk: { title: "Поїздка завершена", body: `Поїздка ${name} завершена. До нових зустрічей!` },
        en: { title: "Trip finished", body: `The trip ${name} is over. See you next time!` },
        ru: { title: "Поездка завершена", body: `Поездка ${name} завершена. До новых встреч!` },
      },
    })[kind][lang];
  }
  return out;
}

export default async function handler(req, res) {
  const secret = (req.query && req.query.secret) || (req.body && req.body.secret);
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(403).json({ error: "bad secret" });
    return;
  }

  const origin = `https://${req.headers.host}`;
  const nowB = berlinParts(new Date());
  const nowMin = nowB.hour * 60 + nowB.minute;
  const dueAt = (h, m) => nowMin >= h * 60 + m && nowMin < h * 60 + m + WINDOW;

  let trips = [], taken = {};
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/trips?select=id,data`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` },
    });
    trips = await r.json();
    const counts = await sb("booked_counts", {});
    (counts || []).forEach((c) => { taken[c.trip_id] = Number(c.taken) || 0; });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
    return;
  }

  const planned = [];

  for (const row of trips || []) {
    const tr = row.data || {};
    const id = row.id;
    const date = String(tr.date || "").trim();
    if (!date) continue;
    const status = String(tr.status || "");
    if (status === "cancelled" || status === "done") continue;

    const days = daysBetween(nowB.date, date);
    const tag = `trip-${id}`;

    // ① За 7 днів о 09:00 — набір відкрито.
    if (days === 7 && dueAt(9, 0)) {
      planned.push({ key: `open:${id}`, tag, msgs: build("open", tr) });
    }

    // ② Лишається мало місць. Перевіряється щоразу, поки запис триває,
    //    і надсилається один раз — далі спрацьовує журнал.
    const spots = Number(tr.spots) || 0;
    const left = spots - (taken[id] || 0);
    if (days >= 0 && spots > 0 && left > 0 && left <= LOW_SPOTS) {
      planned.push({ key: `low:${id}`, tag, msgs: build("low", tr, left) });
    }

    // ③ Напередодні о 22:00 — набір завершено.
    if (days === 1 && dueAt(22, 0)) {
      planned.push({ key: `close:${id}`, tag, msgs: build("close", tr) });
    }

    if (days === 0) {
      // ④ За 2 години до збору.
      const legs = Array.isArray(tr.journeys) && tr.journeys.length > 0
        ? (tr.journeys[0].legs || []) : (tr.legs || []);
      const firstLeg = legs.find((l) => l && String(l.fromTime || "").trim() !== "");
      const meetMin = minutesOf(tr.meetTime) || (firstLeg ? minutesOf(firstLeg.fromTime) : null);
      if (meetMin != null) {
        const remindAt = meetMin - 120;
        const hh = String(Math.floor(meetMin / 60)).padStart(2, "0");
        const mm = String(meetMin % 60).padStart(2, "0");
        if (remindAt >= 0 && nowMin >= remindAt && nowMin < remindAt + WINDOW) {
          const place = tx(tr.meetingPoint, "uk") || (firstLeg ? firstLeg.from : "");
          planned.push({
            key: `meet:${id}`, tag,
            msgs: build("meet", tr, { place, time: `${hh}:${mm}` }),
          });
        }
      }
      // ⑤ О 21:00 — поїздка завершена.
      if (dueAt(21, 0)) {
        planned.push({ key: `end:${id}`, tag, msgs: build("end", tr) });
      }
    }
  }

  const sent = [], skipped = [];
  for (const p of planned) {
    // Спочатку позначаємо в журналі, потім надсилаємо: якщо функцію
    // обірве на півдорозі, краще не надіслати, ніж надіслати двічі.
    let fresh = false;
    try { fresh = await sb("push_log_claim", { p_key: p.key }); }
    catch (e) { skipped.push(`${p.key}: журнал — ${e.message}`); continue; }
    if (!fresh) { skipped.push(`${p.key}: вже надсилалось`); continue; }
    const ok = await sendPush(origin, p.msgs, p.tag);
    (ok ? sent : skipped).push(p.key + (ok ? "" : ": помилка надсилання"));
  }

  res.status(200).json({
    berlin: `${nowB.date} ${String(nowB.hour).padStart(2, "0")}:${String(nowB.minute).padStart(2, "0")}`,
    planned: planned.length, sent, skipped,
  });
}
