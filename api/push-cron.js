// ═══ Tropa Club · api/push-cron.js · ВЕРСІЯ c6 ═══
// c6 — звірка поїздів з табло Deutsche Bahn (api/trains.js): напередодні
//      з 18:00 і в день поїздки організаторові приходить сповіщення,
//      якщо поїзд скасовано, він запізнюється на 10+ хв, змінилась
//      колія чи час або поїзда немає в розкладі DB. Учасникам — ні:
//      повідомити групу вирішує організатор. Вночі (23:00–05:00) тиша.
//      Звірка йде ПІСЛЯ решти сповіщень і має власний таймаут: повільна
//      відповідь DB не затримає нагадування про збір.
//      Перенесена поїздка (стан «postponed») більше не розсилає сповіщень
//      за розкладом: її дата в базі — стара, а нова записана лише текстом.
// c5 — дата й місце збору мовою отримувача: день тижня береться з
//      календарної дати («Субота, 03.10.26» / «Saturday, 03.10.26»),
//      а не з підпису, який міг бути лише українським.
// c4 — кожне сповіщення веде у своє місце застосунку: «набір відкрито»
//      і «мало місць» — до запису, «місць немає» — до контактів,
//      нагадування — до місця збору, «завершено» — до списку поїздок.
// c3 — відмітку пульсу пише сам сервер службовим ключем бази; у звіті
//      видно, чи вона записалась. Потрібен supabase-cron-ping.sql.
// c2 — чернетки пропускаються: поїздка «в розробці» не розсилає
//      сповіщень зі своєю назвою. c1 — без цього захисту.
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
// Чи записалась відмітка — видно в полі "pulse" будь-якої відповіді.
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

export const config = { maxDuration: 60 };

const TZ = "Europe/Berlin";
// Раніше кожне сповіщення мало вікно завширшки 20 хвилин: «рівно о 09:00
// плюс двадцять». Якщо годинник у ці хвилини не викликався — сервіс лежав,
// телефон спав, деплой ішов — момент втрачався НАЗАВЖДИ, бо наступна
// перевірка вже виходила за межі вікна.
// Тепер умова інша: «настав час АБО вже пізніше». Сповіщення піде при
// першій же нагоді після потрібного моменту, а від повторів захищає
// журнал push_log — там ключ можна зайняти лише один раз.
const CATCHUP = true;
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
// Дата за N діб від заданої, у форматі РРРР-ММ-ДД.
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const tx = (v, lang) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v[lang] || v.uk || v.en || v.ru || "";
};
// Дні тижня — ті самі, що в застосунку (App.jsx → WEEKDAYS).
const WEEKDAYS = {
  uk: ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  ru: ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"],
};
// Дата поїздки мовою отримувача: «Субота, 03.10.26» — так само, як на
// картці в застосунку. Раніше бралась з текстового підпису дати: у
// старих поїздках він лише український, і англійське сповіщення
// приходило з «Субота», а без підпису — з голим «2026-10-03».
const whenOf = (tr, lang) => {
  const m = String((tr && tr.date) || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
    return `${(WEEKDAYS[lang] || WEEKDAYS.uk)[d.getUTCDay()]}, ${m[3]}.${m[2]}.${m[1].slice(2)}`;
  }
  return tx(tr && tr.dateLabel, lang);
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

// onlyAdmin — лише на пристрої організатора (так позначені в базі
// телефони, з яких входили з PIN).
async function sendPush(origin, msgs, tag, url, onlyAdmin) {
  const r = await fetch(`${origin}/api/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env.PUSH_SECRET, msgs, url: url || "/", tag, onlyAdmin: Boolean(onlyAdmin) }),
  });
  return r.ok;
}

// ── Поїзди: звірка з табло DB (api/trains.js) ────────────────────────
// Лише організаторові. Вночі тиша: зміну, знайдену між 23:00 і 05:00,
// надішлемо о п'ятій — ключ у журналі займається лише при надсиланні.
const TRAIN_QUIET_FROM = 23 * 60;
const TRAIN_QUIET_TO = 5 * 60;
const TRAIN_DELAY_PUSH = 10;          // запізнення від 10 хв — уже новина
const hashKey = (s) => {
  let h = 5381;
  for (const ch of String(s)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36);
};
const platformSig = (p) => String(p || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
// Що в поїзді не так — короткими мітками для ключа журналу. Новий набір
// міток — нове сповіщення; той самий — повтору не буде.
export function trainIssues(leg) {
  if (!leg) return [];
  if (leg.state === "cancelled") return ["c"];
  if (leg.state === "notfound") return ["nf"];
  const out = [];
  if (leg.partialTo) out.push("x");
  if (Number(leg.delay) >= TRAIN_DELAY_PUSH) out.push(`d${Math.floor(Number(leg.delay) / 10) * 10}`);
  if (leg.platformNow) out.push(`p${platformSig(leg.platformNow)}`);
  if (leg.state === "time" && leg.dbTime) out.push(`t${String(leg.dbTime).replace(":", "")}`);
  return out;
}
const TRAIN_TXT = {
  uk: {
    title: { c: "Поїзд скасовано", nf: "Поїзда немає в розкладі DB", x: "Поїзд не доїде до кінця", d: (n) => `Затримка поїзда +${n} хв`, p: "Змінилась колія", t: "Інший час за DB" },
    train: "поїзд", at: "о", from: "з",
    c: "скасовано", nf: "у розкладі DB не знайдено — можливо, змінився розклад або в поїздці описка",
    x: (to) => `не доїде до ${to}`, d: (time, n) => `відправиться о ${time} (+${n} хв)`,
    p: (now, was, typed) => `колія ${now}${was ? ` замість ${was}` : typed ? ` (у поїздці ${typed})` : ""}`,
    t: (time) => `за DB відправлення о ${time}`, tail: "Перевір на bahn.de.",
  },
  en: {
    title: { c: "Train cancelled", nf: "Train not in the DB timetable", x: "Train won't run the full route", d: (n) => `Train delayed +${n} min`, p: "Platform changed", t: "Different time at DB" },
    train: "train", at: "at", from: "from",
    c: "cancelled", nf: "not found in the DB timetable — the schedule may have changed or the trip has a typo",
    x: (to) => `won't reach ${to}`, d: (time, n) => `departs at ${time} (+${n} min)`,
    p: (now, was, typed) => `platform ${now}${was ? ` instead of ${was}` : typed ? ` (trip says ${typed})` : ""}`,
    t: (time) => `DB departure at ${time}`, tail: "Check bahn.de.",
  },
  ru: {
    title: { c: "Поезд отменён", nf: "Поезда нет в расписании DB", x: "Поезд не доедет до конца", d: (n) => `Задержка поезда +${n} мин`, p: "Изменился путь", t: "Другое время у DB" },
    train: "поезд", at: "в", from: "из",
    c: "отменён", nf: "в расписании DB не найден — возможно, изменилось расписание или в поездке опечатка",
    x: (to) => `не доедет до ${to}`, d: (time, n) => `отправится в ${time} (+${n} мин)`,
    p: (now, was, typed) => `путь ${now}${was ? ` вместо ${was}` : typed ? ` (в поездке ${typed})` : ""}`,
    t: (time) => `по DB отправление в ${time}`, tail: "Проверь на bahn.de.",
  },
};
export function buildTrainMsg(tr, leg, issues) {
  const out = {};
  const order = ["c", "nf", "x", "d", "p", "t"];
  const main = order.find((k) => issues.some((i) => i.startsWith(k) && (k !== "d" || /^d\d/.test(i)))) || "p";
  for (const lang of ["uk", "en", "ru"]) {
    const T = TRAIN_TXT[lang];
    const parts = [];
    for (const i of issues) {
      if (i === "c") parts.push(T.c);
      else if (i === "nf") parts.push(T.nf);
      else if (i === "x") parts.push(T.x(leg.partialTo));
      else if (i.startsWith("d")) parts.push(T.d(leg.newTime, leg.delay));
      else if (i.startsWith("p")) parts.push(T.p(leg.platformNow, leg.platformWas, leg.platformTyped));
      else if (i.startsWith("t")) parts.push(T.t(leg.dbTime));
    }
    const title = main === "d" ? T.title.d(leg.delay) : T.title[main];
    const head = `${whenOf(tr, lang)} ${tx(tr.title, lang)}: ${leg.train || T.train} ${T.at} ${leg.time} ${T.from} ${leg.from}`;
    out[lang] = { title, body: `${head} — ${parts.join("; ")}. ${T.tail}` };
  }
  return out;
}

// Куди веде натискання на сповіщення. Застосунок відкриває поїздку й
// прокручує до розділу, де з новиною можна щось зробити:
//   booking — запис у поїздку, contact — контакти організатора,
//   meeting — місце й час збору, home — список усіх поїздок.
// Без «to» — просто сторінка поїздки згори.
const goTo = (id, to) => {
  if (to === "home") return "/?to=home";
  const base = `/?trip=${encodeURIComponent(String(id))}`;
  return to ? `${base}&to=${to}` : base;
};
const GO = { open: "booking", low: "booking", full: "contact", close: "", meet: "meeting", end: "home" };

// ── Тексти сповіщень трьома мовами ──────────────────────────────────
function build(kind, tr, extra) {
  const out = {};
  // Об'єкт нижче будується ЦІЛКОМ на кожному виклику, тож рядки для
  // «meet» обчислюються навіть тоді, коли потрібен «open». Без цієї
  // заглушки extra.place кидав помилку й валив усю функцію — саме тому
  // годинник віддавав 500, щойно якесь сповіщення ставало на часі.
  const e = extra || {};
  for (const lang of ["uk", "en", "ru"]) {
    const name = tx(tr.title, lang);
    const when = whenOf(tr, lang);
    // Місце збору теж кожною мовою: раніше воно бралось українське для всіх.
    const place = tx(tr.meetingPoint, lang) || e.station || "";
    out[lang] = ({
      open: {
        uk: { title: "Відкрито запис у групу", body: `Запис у групу на ${when} до ${name} відкритий. Встигніть записатися!` },
        en: { title: "Sign-up is open", body: `Sign-up for the trip to ${name} on ${when} is open. Grab your spot!` },
        ru: { title: "Открыта запись в группу", body: `Запись в группу на ${when} до ${name} открыта. Успейте записаться!` },
      },
      low: {
        uk: { title: "Лишається мало місць", body: `Залишилось всього ${e.n} місць у набір до ${when} ${name}!` },
        en: { title: "Only a few spots left", body: `Only ${e.n} spots left for the trip to ${name} on ${when}!` },
        ru: { title: "Остаётся мало мест", body: `Осталось всего ${e.n} мест в набор до ${when} ${name}!` },
      },
      // Місць немає — окреме сповіщення від «мало місць».
      full: {
        uk: { title: "Місця закінчились", body: `Місця на ${when} до ${name} закінчились. Зв'яжіться з організатором, можливо є вільне місце.` },
        en: { title: "No spots left", body: `The trip to ${name} on ${when} is full. Contact the organiser — a spot may free up.` },
        ru: { title: "Места закончились", body: `Места на ${when} до ${name} закончились. Свяжитесь с организатором, возможно есть свободное место.` },
      },
      close: {
        uk: { title: "Набір завершено", body: `Набір у групу на ${when} до ${name} завершений.` },
        en: { title: "Sign-up closed", body: `Sign-up for the trip to ${name} on ${when} is closed.` },
        ru: { title: "Набор завершён", body: `Набор в группу на ${when} до ${name} завершён.` },
      },
      meet: {
        uk: { title: "Нагадування про збір", body: `${when} ${name}: ${place}, ${e.time}. Приходьте вчасно.` },
        en: { title: "Meeting reminder", body: `${when} ${name}: ${place}, ${e.time}. Please be on time.` },
        ru: { title: "Напоминание о сборе", body: `${when} ${name}: ${place}, ${e.time}. Приходите вовремя.` },
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
  // Ключ приймаємо двома шляхами.
  //
  // Vercel, запускаючи розклад сам, НЕ вміє додавати ?secret= у адресу —
  // він надсилає заголовок Authorization: Bearer <CRON_SECRET>. Раніше
  // перевірявся лише ?secret=, тому автоматичний виклик відхилявся з
  // 403, і жодне сповіщення не йшло.
  //
  // Дописувати ключ у саму адресу в vercel.json не можна: репозиторій
  // відкритий, і ключ побачив би будь-хто.
  const fromQuery = (req.query && req.query.secret) || (req.body && req.body.secret);
  const auth = String((req.headers && req.headers.authorization) || "");
  const fromHeader = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const secret = fromQuery || fromHeader;
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
  const trainTrips = [];

  // Поїздки в розробці повністю пропускаємо. Без цього чернетка сама
  // розіслала б усім «набір відкрито» зі своєю назвою — тобто показала
  // б саме те, що від глядачів ховається. Пропускаємо ДО журналу
  // push_log: так жоден ключ не займається завчасно, і коли поїздку
  // опублікують, її сповіщення підуть як звичайно.
  for (const row of (trips || []).filter((r) => !(r && r.data && r.data.draft === true))) {
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
    if (status === "cancelled" || status === "done" || status === "postponed") {
      report.push({ id, name, date, skip: `стан «${status}» — сповіщення вимкнені` });
      continue;
    }

    const days = daysBetween(nowB.date, date);
    const tag = `trip-${id}`;

    // ① За 7 днів о 09:00 — набір відкрито. Або будь-коли пізніше,
    //    якщо той момент проґавили.
    // Рівно за ШІСТЬ діб до поїздки о 18:00 — і тільки того дня.
    //
    // Було «за 7 діб або пізніше, при першій нагоді». Через це сповіщення
    // приходило на добу пізніше: момент на сьомий день о 18:00 губився
    // (годинник у ті хвилини не викликався), а наздоганяння спрацьовувало
    // вже наступного дня в довільну годину.
    //
    // Шість діб, а не сім, — це те, що ви задавали прикладами: поїздка в
    // суботу 05.09 → сповіщення в неділю 30.08; поїздка в неділю 20.09 →
    // сповіщення в понеділок 14.09. Обидва рази це шостий день до.
    const openDay = addDays(date, -6);
    const openDue = nowB.date === openDay && nowMin >= 18 * 60;
    if (openDue) planned.push({ key: `open:${id}`, tag, msgs: build("open", tr), url: goTo(id, GO.open) });
    else why.push(`open — потрібен день ${openDay} після 18:00 · зараз ${nowB.date} ${hhmm(nowMin)}`);

    // ② Лишається мало місць. Перевіряється щоразу, надсилається один раз.
    const spots = Number(tr.spots) || 0;
    const left = spots - (taken[id] || 0);
    if (days >= 0 && spots > 0 && left > 0 && left <= LOW_SPOTS) {
      planned.push({ key: `low:${id}`, tag, msgs: build("low", tr, { n: left }), url: goTo(id, GO.low) });
    } else why.push(`low — треба вільних 1–${LOW_SPOTS} · зараз ${left} з ${spots}`);
    // Місць не лишилось узагалі — інше сповіщення, свій ключ.
    if (days >= 0 && spots > 0 && left <= 0) {
      planned.push({ key: `full:${id}`, tag, msgs: build("full", tr), url: goTo(id, GO.full) });
    } else why.push(`full — треба 0 вільних · зараз ${left} з ${spots}`);

    // ③ Напередодні о 22:00 — набір завершено. Або пізніше, при першій
    //    нагоді: краще з запізненням, ніж ніколи.
    // Час беремо з ВАШОГО дедлайну, а не з жорстко зашитої 22:00.
    // І сповіщення НЕ переходить на наступну добу: раніше діяло просто
    // «настав час або пізніше», тож пропущений вечір означав, що «набір
    // завершено» прилітало вже після опівночі. Тепер, якщо доба
    // скінчилась, воно пропускається — краще не надіслати, ніж
    // розбудити людей о 00:15.
    // Дедлайн зберігається як «2026-09-04T21:00» — БЕЗ позначки поясу.
    // Через new Date() сервер читав це як час за Гринвічем, тобто на дві
    // години пізніше за баварський. Тому розбираємо рядок напряму: цифри
    // в ньому вже є берлінським часом, бо саме його вписує організатор.
    const dm = String(tr.deadline || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    const closeDay = dm ? dm[1] : addDays(date, -1);
    const closeMin = dm ? Number(dm[2]) * 60 + Number(dm[3]) : 22 * 60;
    const closeDue = nowB.date === closeDay && nowMin >= closeMin;
    if (closeDue) planned.push({ key: `close:${id}`, tag, msgs: build("close", tr), url: goTo(id, GO.close) });
    else why.push(`close — потрібен день ${closeDay} після ${hhmm(closeMin)} · зараз ${nowB.date} ${hhmm(nowMin)}`);

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
        // Три години замість двох: люди їдуть із різних міст, і комусь
        // треба виїхати з дому раніше за сам збір.
        const remindAt = Math.max(0, meetMin - 180);
        // Запасне місце — станція першого поїзда; саме місце збору build()
        // бере вже мовою отримувача.
        const station = firstLeg ? firstLeg.from : "";
        // Вікно від «за 2 години» до самого часу збору. Після збору
        // нагадування вже безглузде, тому далі не надсилаємо.
        if (nowMin >= remindAt && nowMin < meetMin) {
          planned.push({ key: `meet:${id}`, tag, msgs: build("meet", tr, { station, time: hhmm(meetMin) }), url: goTo(id, GO.meet) });
        } else {
          why.push(`meet — збір ${hhmm(meetMin)}, вікно ${hhmm(remindAt)}–${hhmm(meetMin)} (за 3 год) · зараз ${hhmm(nowMin)}`);
        }
      }
      // ⑤ О 21:00 — поїздка завершена. Або пізніше того ж вечора.
      if (nowMin >= 21 * 60) planned.push({ key: `end:${id}`, tag, msgs: build("end", tr), url: goTo(id, GO.end) });
      else why.push(`end — треба після 21:00 · зараз ${hhmm(nowMin)}`);
    } else {
      why.push(`meet — тільки в день поїздки · зараз днів ${days}`);
    }

    // ⑥ Поїзди: напередодні з 18:00 і в день поїздки.
    if (days === 0 || (days === 1 && nowMin >= 18 * 60)) trainTrips.push({ id, tr, name });
    else why.push("trains — звірка з DB напередодні з 18:00 і в день поїздки");

    report.push({
      id, name, date, days, status,
      spots, taken: taken[id] || 0,
      meetTime: tr.meetTime || (tr.from && tr.from.time) || "не задано",
      why,
    });
  }

  // Пульс. Ставимо ДО надсилання: навіть якщо далі щось впаде, буде
  // видно, що годинник живий і о котрій озивався.
  //
  // Відмітку пише сам сервер СЛУЖБОВИМ ключем бази — тим самим, яким
  // видаляються завантаження. Раніше функція в базі звіряла власну
  // копію CRON_SECRET, вписану прямо в її текст. Коли ключ замінили
  // (він засвітився на скріншоті), Vercel і cron-job.org отримали
  // новий, а копія в базі лишилась старою. База мовчки відхиляла кожну
  // відмітку, і з 20.09 здавалося, що годинник стоїть, хоча він
  // працював. Тепер ключ годинника живе лише у Vercel і cron-job.org, і
  // наступна заміна нічого не зламає.
  //
  // І помилка більше не ковтається мовчки: результат іде у відповідь —
  // і у звіт ?debug=1, і в історію викликів cron-job.org.
  const beat = await (async () => {
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!KEY) return "не записано: у Vercel немає SUPABASE_SERVICE_ROLE_KEY";
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/cron_ping`, {
        method: "POST",
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_note: `${nowText} · поїздок ${(trips || []).length} · на часі ${planned.length}` }),
      });
      if (r.ok) return "записано";
      const txt = (await r.text()).slice(0, 200);
      // Найімовірніша причина — не виконано supabase-cron-ping.sql:
      // тоді в базі ще стара функція з двома параметрами.
      return `не записано: помилка ${r.status} ${txt}`;
    } catch (e) {
      return `не записано: ${String((e && e.message) || e).slice(0, 200)}`;
    }
  })();

  // Спершу — звичайні сповіщення; звірка поїздів іде після них (див. c6).
  const sent = [], skipped = [];
  const deliver = async (list) => {
    for (const p of list) {
      let fresh = false;
      try { fresh = await sb("push_log_claim", { p_key: p.key }); }
      catch (e) { skipped.push(`${p.key}: журнал — ${e.message}`); continue; }
      if (!fresh) { skipped.push(`${p.key}: вже надсилалось`); continue; }
      // Якщо надсилання впаде, це не має валити весь прохід: решта
      // сповіщень мусить дійти.
      let ok = false;
      try { ok = await sendPush(origin, p.msgs, p.tag, p.url, p.admin); }
      catch (e) { ok = false; }
      (ok ? sent : skipped).push(p.key + (ok ? "" : ": помилка надсилання"));
    }
  };
  if (!debug) await deliver(planned);

  // Звірка поїздів. Сам похід у DB робить api/trains.js — той самий, що
  // показує стан поїздів у застосунку; &fresh=… обходить двохвилинний кеш.
  const trainReport = [];
  const trainPlanned = [];
  const quiet = nowMin >= TRAIN_QUIET_FROM || nowMin < TRAIN_QUIET_TO;
  await Promise.all(trainTrips.map(async ({ id, tr, name }) => {
    const item = { id, name, legs: [] };
    trainReport.push(item);
    let j = null;
    try {
      // Власний таймаут: DB буває повільним, а годинник не може чекати
      // вічно (cron-job.org сам обриває виклик за 30 секунд).
      const r = await fetch(`${origin}/api/trains?trip=${encodeURIComponent(String(id))}&fresh=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
      j = await r.json();
    } catch (e) {
      item.error = `api/trains не відповів: ${String((e && e.message) || e).slice(0, 120)}`;
      return;
    }
    if (!j || j.configured === false) { item.note = "не налаштовано: у Vercel немає DB_CLIENT_ID і DB_API_KEY"; return; }
    if (j.auth === false) {
      item.error = "DB не приймає ключі";
      // Раз на добу кажемо організаторові, що звірка не працює: інакше він
      // думав би, що поїзди просто за розкладом.
      if (!quiet) trainPlanned.push({
        key: `trn-auth:${nowB.date}`, tag: "trains", admin: true, url: goTo(id, "travel"),
        msgs: {
          uk: { title: "Звірка поїздів з DB не працює", body: "DB не приймає ключі. Перевір DB_CLIENT_ID і DB_API_KEY у Vercel та підписку на Timetables." },
          en: { title: "DB train check is not working", body: "DB rejects the keys. Check DB_CLIENT_ID and DB_API_KEY in Vercel and the Timetables subscription." },
          ru: { title: "Сверка поездов с DB не работает", body: "DB не принимает ключи. Проверь DB_CLIENT_ID и DB_API_KEY в Vercel и подписку на Timetables." },
        },
      });
      return;
    }
    if (j.error) item.error = j.error;
    for (const leg of (j.legs || [])) {
      const issues = trainIssues(leg);
      item.legs.push(`${leg.train || "поїзд"} ${leg.time} ${leg.from}: ${leg.state}${issues.length ? ` [${issues.join(",")}]` : ""}`);
      if (issues.length === 0) continue;
      if (quiet) { item.legs.push("  ↳ тиша 23:00–05:00 — надішлемо зранку"); continue; }
      // Окремий тег для кожного поїзда: два сповіщення поспіль не
      // заміщають одне одного на екрані телефона. Дата в ключі — щоб після
      // перенесення поїздки на інший день та сама зміна знову дійшла.
      trainPlanned.push({
        key: `trn:${id}:${tr.date}:${hashKey(leg.key)}:${[...issues].sort().join(",")}`,
        tag: `trains-${id}-${hashKey(leg.key)}`, admin: true, url: goTo(id, "travel"),
        msgs: buildTrainMsg(tr, leg, issues),
      });
    }
  }));

  if (debug) {
    res.status(200).json({
      berlin: nowText,
      window: "від моменту й пізніше",
      trips: report,
      planned: planned.concat(trainPlanned).map((p) => `${p.key} → ${p.url}${p.admin ? " (лише організаторові)" : ""}`),
      trains: trainReport,
      pulse: beat,
      note: "РЕЖИМ ЗВІТУ — нічого не надіслано",
    });
    return;
  }

  await deliver(trainPlanned);

  res.status(200).json({ berlin: nowText, pulse: beat, planned: planned.length + trainPlanned.length, sent, skipped, trains: trainReport });
}
