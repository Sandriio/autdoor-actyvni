// ═══════════════════════════════════════════════════════════════════
// ГОДИННИК СПОВІЩЕНЬ
//
// Цю адресу смикає cron-job.org кожні 15 хвилин. Функція дивиться на
// всі поїздки й вирішує, чи настав час якогось зі сповіщень.
//
// ДВА РЕЖИМИ
//   ?secret=...            — робочий: надсилає те, що на часі
//   ?secret=...&debug=1    — звіт: НІЧОГО не надсилає, але пояснює
//                            по кожній поїздці, що спрацює й чому ні
//
// ПУЛЬС
// Кожен виклик лишає відмітку часу в базі. У режимі організатора видно,
// коли годинник озивався востаннє. Якщо «ніколи» — cron-job.org не
// працює, і шукати помилку в текстах сповіщень немає сенсу.
//
// ЗАХИСТ ВІД ПОВТОРІВ
// Кожна відправка позначається унікальним ключем у таблиці push_log.
// Друга спроба з тим самим ключем нічого не робить.
//
// ЧАС
// Сервер працює за UTC, поїздки — за німецьким часом. Усі порівняння
// в поясі Europe/Berlin, інакше влітку все приїжджало б на дві години
// раніше.
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
  const m = String(v == null ? "" : v).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
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

// ── Тексти сповіщень трьома мовами ──────────────────────────────────
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
  const debug = String((req.query && req.query.debug) || "") === "1";
  const nowB = berlinParts(new Date());
  const nowMin = nowB.hour * 60 + nowB.minute;
  const nowText = `${nowB.date} ${hhmm(nowMin)}`;
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
  const report = [];

  for (const row of trips || []) {
    const tr = row.data || {};
    const id = row.id;
    const name = tx(tr.title, "uk");
    const date = String(tr.date || "").trim();
    const status = String(tr.status || "upcoming");
    const why = [];

    if (!date) {
      report.push({ id, name, skip: "немає календарної дати — жодне сповіщення неможливе" });
      continue;
    }
    if (status === "cancelled" || status === "done") {
      report.push({ id, name, date, skip: `стан «${status}» — сповіщення вимкнені` });
      continue;
    }

    const days = daysBetween(nowB.date, date);
    const tag = `trip-${id}`;

    // ① За 7 днів о 09:00 — набір відкрито.
    if (days === 7 && dueAt(9, 0)) planned.push({ key: `open:${id}`, tag, msgs: build("open", tr) });
    else why.push(`open — треба днів 7 і час 09:00–09:20 · зараз днів ${days}, ${hhmm(nowMin)}`);

    // ② Лишається мало місць. Перевіряється щоразу, надсилається один раз.
    const spots = Number(tr.spots) || 0;
    const left = spots - (taken[id] || 0);
    if (days >= 0 && spots > 0 && left > 0 && left <= LOW_SPOTS) {
      planned.push({ key: `low:${id}`, tag, msgs: build("low", tr, left) });
    } else why.push(`low — треба вільних 1–${LOW_SPOTS} · зараз ${left} з ${spots}`);

    // ③ Напередодні о 22:00 — набір завершено.
    if (days === 1 && dueAt(22, 0)) planned.push({ key: `close:${id}`, tag, msgs: build("close", tr) });
    else why.push(`close — треба днів 1 і час 22:00–22:20 · зараз днів ${days}, ${hhmm(nowMin)}`);

    if (days === 0) {
      const legs = Array.isArray(tr.journeys) && tr.journeys.length > 0
        ? (tr.journeys[0].legs || []) : (tr.legs || []);
      const firstLeg = legs.find((l) => l && String(l.fromTime || "").trim() !== "");
      // Пріоритет: окреме поле часу зустрічі → час у точці збору →
      // відправлення першого поїзда. Останнє найгірше: це час найдальшого
      // міста, а не збору групи.
      const meetMin = minutesOf(tr.meetTime)
        || minutesOf(tr.from && tr.from.time)
        || (firstLeg ? minutesOf(firstLeg.fromTime) : null);
      if (meetMin == null) {
        why.push("meet — час зустрічі не заповнено: нема від чого відлічувати дві години");
      } else {
        const remindAt = meetMin - 120;
        const place = tx(tr.meetingPoint, "uk") || (firstLeg ? firstLeg.from : "");
        if (remindAt >= 0 && nowMin >= remindAt && nowMin < remindAt + WINDOW) {
          planned.push({ key: `meet:${id}`, tag, msgs: build("meet", tr, { place, time: hhmm(meetMin) }) });
        } else {
          why.push(`meet — збір ${hhmm(meetMin)}, нагадування о ${hhmm(Math.max(0, remindAt))} · зараз ${hhmm(nowMin)}`);
        }
      }
      // ⑤ О 21:00 — поїздка завершена.
      if (dueAt(21, 0)) planned.push({ key: `end:${id}`, tag, msgs: build("end", tr) });
      else why.push(`end — треба час 21:00–21:20 · зараз ${hhmm(nowMin)}`);
    } else {
      why.push(`meet і end — тільки в день поїздки · зараз днів ${days}`);
    }

    report.push({
      id, name, date, days, status,
      spots, taken: taken[id] || 0,
      meetTime: tr.meetTime || (tr.from && tr.from.time) || "не задано",
      why,
    });
  }

  // Пульс. Ставимо ДО надсилання: навіть якщо далі щось впаде, буде
  // видно, що годинник живий і о котрій озивався.
  await sb("cron_ping", {
    p_secret: process.env.CRON_SECRET,
    p_note: `${nowText} · поїздок ${(trips || []).length} · на часі ${planned.length}`,
  }).catch(() => {});

  if (debug) {
    res.status(200).json({
      berlin: nowText,
      window: `${WINDOW} хв`,
      trips: report,
      planned: planned.map((p) => p.key),
      note: "РЕЖИМ ЗВІТУ — нічого не надіслано",
    });
    return;
  }

  const sent = [], skipped = [];
  for (const p of planned) {
    let fresh = false;
    try { fresh = await sb("push_log_claim", { p_key: p.key }); }
    catch (e) { skipped.push(`${p.key}: журнал — ${e.message}`); continue; }
    if (!fresh) { skipped.push(`${p.key}: вже надсилалось`); continue; }
    const ok = await sendPush(origin, p.msgs, p.tag);
    (ok ? sent : skipped).push(p.key + (ok ? "" : ": помилка надсилання"));
  }

  res.status(200).json({ berlin: nowText, planned: planned.length, sent, skipped });
}
