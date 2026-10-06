// ═══ Tropa Club · api/fill-trip.js · ВЕРСІЯ f3 ═══
// ═══════════════════════════════════════════════════════════════════
// Помічники Claude для організатора — усі в одному файлі
//
// НАВІЩО ОДИН ФАЙЛ
// На безкоштовному тарифі Vercel (Hobby) у проєкті може бути не більше
// 12 серверних функцій, а в папці api їх уже дев'ять. Тому всі помічники
// живуть тут і відрізняються полем mode.
//
// ЩО ВМІЄ (POST, лише з PIN організатора — ключ платний)
//  • mode "announce" (v144) — перший абзац оголошення для Telegram.
//    Решту оголошення (дата, збір, поїзди, місця, посилання) застосунок
//    складає сам із полів поїздки, тож факти розійтися не можуть.
//    { trip, style } → { intro }
//  • mode "schedule" (v144) — розклад, скопійований з DB Navigator чи
//    bahn.de, → відправлення, поїзди, колії, пересадки, дорога назад.
//    { text, tripDate } → { journeys, returnFrom, returnTime, returnPlatform, date, notes }
//  • mode "route" (v144) — точки маршруту з GPX/KML чи Google Maps.
//    Трек застосунок розбирає сам (відстань, висоти) і сам шукає місця
//    поруч на OpenStreetMap; сюди приходить лише список кандидатів.
//    Claude обирає точки, пише назви українською й короткі описи.
//    { kind, title, stats, candidates } → { points, notes }
//  • mode "gmaps" (v144) — посилання Google Maps → список зупинок
//    (назви й координати). Без Claude, безкоштовно.
//    { url } → { stops, travel }
//  • mode "trip" (v143) — заповнити поїздку з тексту оголошення. З v144
//    кнопки в застосунку немає (поїздка спершу вноситься в застосунок),
//    але сервер її ще розуміє.
//  • GET — перевірка без витрат: чи є ключ, чи він дійсний, чи є модель.
//
// ВАРТІСТЬ
// Claude Sonnet 5.5 — $2 за мільйон вхідних і $10 за мільйон вихідних
// токенів (жовтень 2026). Перший абзац оголошення — менше цента, розклад —
// близько цента, точки маршруту — 2–4 центи. Кошти — з передоплати в
// Claude Console (platform.claude.com → Settings → Billing); там же
// місячний ліміт витрат.
//
// ЗМІННІ СЕРЕДОВИЩА (Vercel → Settings → Environment Variables)
//  • ANTHROPIC_API_KEY — ключ із platform.claude.com → Settings → API keys.
//    Живе ЛИШЕ тут. У код, у GitHub і в чати його не вставляємо.
//    Ключ знаходиться й під схожою назвою (CLAUDE_API_KEY, з опискою —
//    як ANTROPIC_API_KEY) або за початком значення «sk-ant-». GET показує,
//    з якої змінної його взято (лише назву, не значення).
//  • CLAUDE_MODEL — необов'язково; інша модель, якщо колись знадобиться.
//  • SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — ті самі, що вже є.
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

export const VERSION = "f3";
const API = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-sonnet-5-5";
// Запасна модель: якщо основна не прийме параметрів запиту (400) чи її вже
// немає (404) — ще раз простішим запитом, щоб кнопка не ламалась через
// зміни в Claude API.
const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
// Ціни за мільйон токенів (вхід / вихід), $ — лише щоб показати, скільки
// коштував виклик. Невідома модель — вартість просто не показується.
const PRICES = {
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-haiku-4-5": [1, 5],
  "claude-opus-5-5": [4, 20],
};
// Скільки часу є в усього запиту: Vercel обриває функцію на 60-й секунді.
const BUDGET_MS = 54000;

const MAX_TEXT = 12000;
const PLACE_TYPES = ["mountain", "lake", "city", "gorge", "forest", "valley", "river", "museum", "waterfall", "bike"];
const DIFFICULTIES = ["Легкий", "Середній", "Складний"];

// ── Спільні дрібниці ────────────────────────────────────────────────
const S = { type: "string" };
const obj = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);
const line = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
export function hhmm(v) {
  const m = String(v == null ? "" : v).match(/^\s*(\d{1,2})[:.](\d{2})\s*$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
export function isoDate(v) {
  const m = String(v || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : "";
}
function isoLocal(v) {
  const m = String(v || "").trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})$/);
  if (!m || !isoDate(m[1]) || !hhmm(m[2])) return "";
  return `${m[1]}T${hhmm(m[2])}`;
}
function num(v, decimals) {
  const s = String(v == null ? "" : v).replace(",", ".").match(decimals ? /\d+(\.\d+)?/ : /\d+/);
  return s ? s[0] : "";
}
const finite = (v) => (typeof v === "number" ? v : parseFloat(v));
const numOr = (v, d) => { const n = finite(v); return Number.isFinite(n) ? n : d; };
// Колія: «Gl. 27», «колія 5a», «Gleis 3-4» → «27», «5a», «3-4».
export const platform = (v) => str(v, 14)
  .replace(/^(колія|колiя|кол\.?|путь|gleis|gl\.?|platform|pl\.?|steig|bstg\.?|bahnsteig)\s*/i, "")
  .trim().slice(0, 8);
// Поїзд: «RB 6 (59457)» → «RB 6»; «RE70» → «RE 70»; «Bus 9606» лишається.
export function trainName(v) {
  let s = line(v, 40).replace(/\s*\(\s*\d{3,6}\s*\)\s*$/, "");
  s = s.replace(/^([A-Za-zÄÖÜäöü]{1,4})(\d{1,5})$/, "$1 $2");
  return s.slice(0, 30);
}

const WD = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
// Сьогоднішня дата в Берліні: «2026-10-05».
export function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
// Календар на N днів уперед: модель бере дні тижня звідси, а не рахує сама.
export function calendar(today, days = 150) {
  const [y, m, d] = today.split("-").map(Number);
  const out = [];
  for (let i = 0; i < days; i++) {
    const x = new Date(Date.UTC(y, m - 1, d + i));
    out.push(`${x.toISOString().slice(0, 10)} ${WD[x.getUTCDay()]}`);
  }
  return out.join("\n");
}

// ═══ mode "trip" — поїздка з тексту оголошення (v143) ═══════════════
export const SCHEMA_TRIP = obj({
  title: S, subtitle: S, date: S, about: S,
  placeType: { type: "string", enum: ["", ...PLACE_TYPES] },
  difficulty: { type: "string", enum: ["", ...DIFFICULTIES] },
  difficultyNote: S,
  distanceKm: S, durationHrs: S, ascentM: S, descentM: S,
  spots: S, deadline: S,
  meetTime: S, meetingPoint: S, meetingPlaceQuery: S,
  priceNote: S,
  journeys: { type: "array", items: obj({
    legs: { type: "array", items: obj({ from: S, fromTime: S, platform: S, train: S, to: S, toTime: S, toPlatform: S }) },
  }) },
  returnFrom: S, returnTime: S, returnPlatform: S,
  route: { type: "array", items: obj({ name: S, t: S, note: S, info: S }) },
  packing: { type: "array", items: S },
  contacts: { type: "array", items: obj({ name: S, role: S, telegram: S, phone: S }) },
  cafes: { type: "array", items: obj({ name: S, note: S, tag: S }) },
  routeUrl: S,
  notes: S,
});

export function systemPromptTrip(today) {
  const wd = WD[new Date(`${today}T12:00:00Z`).getUTCDay()];
  return `You fill in a trip form for "Tropa Club", which runs one-day group trips (hiking, lakes, mountains, towns) in Bavaria, Germany, for a Ukrainian-speaking community. The organizer pasted the announcement of ONE trip. Extract its details into the JSON schema.

Rules:
1. Use ONLY facts stated in the announcement. Never invent or guess. If something is not stated, use "" (or [] for lists).
2. Write all descriptive text in Ukrainian. If the announcement is in Russian or another language, translate it into natural Ukrainian. Keep proper names as written in the original (German names of stations, mountains, lakes, cafés; train names like "RE 9"). No emojis, no hashtags, no Markdown.
3. Today is ${today} (${wd}), Europe/Berlin. The trip is in the future. Use the calendar below for dates and weekdays — never compute weekdays yourself. If the year is missing, pick the nearest future date that matches (and matches the weekday, if one is given).
4. Formats: date "YYYY-MM-DD"; times "HH:MM" (24-hour); deadline "YYYY-MM-DDTHH:MM" — if only a day is given, use 23:59; if it is relative (e.g. "until Thursday 20:00"), resolve it to the nearest such moment before the trip. Numbers as plain digits with a dot for decimals ("12.5"), without units.
5. title — the destination name only, short, as in the announcement (e.g. "Айбзеє"). subtitle — a short tagline (up to ~60 characters) only if the announcement has one or its first line clearly is one.
6. about — 2–6 sentences about the place and the plan, using only the announcement's content.
7. meetTime — the time of gathering (збір, зустріч), not the train departure, unless the announcement says to meet right at the train. meetingPoint — where to meet, as described, in Ukrainian. meetingPlaceQuery — a short map search query in Latin script for that place (e.g. "München Hauptbahnhof"), or "" if no place is given.
8. journeys — trains to the destination. One journey per departure city or group; inside it one leg per train, in order: from (station), fromTime, platform (only the number or letter), train (e.g. "RE 9", "RB 6", "BRB", "S 4"), to, toTime, toPlatform. Unknown parts stay "". returnFrom, returnTime, returnPlatform — the train back, if stated.
9. priceNote — ticket or travel cost info (e.g. "Bayern-Ticket ~15 € з особи"). A participation fee or other price that does not fit goes into notes.
10. spots — number of places. distanceKm, durationHrs (as written, e.g. "4–5 год"), ascentM, descentM.
11. difficulty — "Легкий", "Середній" or "Складний" only if stated or clearly implied (e.g. "для початківців" → "Легкий"); otherwise "". difficultyNote — who it suits or what to consider, if stated.
12. placeType — the main type of the destination: one of ${PLACE_TYPES.join(", ")}; "" if unclear.
13. route — main points of the walking route, in order: name, t (time "HH:MM" if stated), note (short), info (extra facts: prices, opening hours).
14. packing — what to bring, one short item per entry, in Ukrainian.
15. contacts — organizer or guide contacts, only if stated: name, role, telegram (with @), phone.
16. cafes — places to eat, if mentioned: name, note, tag (e.g. "€€ · біля станції").
17. routeUrl — a Komoot, Bergfex or Outdooractive link, if present.
18. notes — in Ukrainian, 1–3 short sentences for the organizer: important facts that did not fit any field, or things to double-check. "" if none.

Calendar (date, weekday):
${calendar(today)}`;
}

function cleanLegs(rawLegs) {
  return list(rawLegs, 10).map((l) => ({
    from: line(l && l.from, 80), fromTime: hhmm(l && l.fromTime), platform: platform(l && l.platform),
    train: trainName(l && l.train), to: line(l && l.to, 80), toTime: hhmm(l && l.toTime), toPlatform: platform(l && l.toPlatform),
    transfer: "",
  })).filter((l) => l.from || l.fromTime || l.train || l.to || l.toTime);
}

export function cleanFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    title: str(r.title, 80),
    subtitle: str(r.subtitle, 120),
    date: isoDate(r.date),
    about: str(r.about, 3000),
    placeType: PLACE_TYPES.includes(String(r.placeType || "").trim().toLowerCase()) ? String(r.placeType).trim().toLowerCase() : "",
    difficulty: DIFFICULTIES.find((d) => d.toLowerCase() === String(r.difficulty || "").trim().toLowerCase()) || "",
    difficultyNote: str(r.difficultyNote, 300),
    distanceKm: num(r.distanceKm, true),
    durationHrs: str(r.durationHrs, 40),
    ascentM: num(r.ascentM),
    descentM: num(r.descentM),
    spots: num(r.spots),
    deadline: isoLocal(r.deadline),
    meetTime: hhmm(r.meetTime),
    meetingPoint: str(r.meetingPoint, 500),
    meetingPlaceQuery: str(r.meetingPlaceQuery, 120),
    priceNote: str(r.priceNote, 300),
    journeys: list(r.journeys, 6).map((j) => ({ legs: cleanLegs(j && j.legs) })).filter((j) => j.legs.length > 0),
    returnFrom: line(r.returnFrom, 80),
    returnTime: hhmm(r.returnTime),
    returnPlatform: platform(r.returnPlatform),
    route: list(r.route, 30).map((p) => ({
      name: str(p && p.name, 120), t: hhmm(p && p.t), note: str(p && p.note, 300), info: str(p && p.info, 600),
    })).filter((p) => p.name),
    packing: list(r.packing, 40).map((x) => str(x, 120)).filter(Boolean),
    contacts: list(r.contacts, 5).map((c) => ({
      name: str(c && c.name, 60), role: str(c && c.role, 60),
      telegram: (() => { const t = str(c && c.telegram, 60).replace(/^https?:\/\/t\.me\//i, ""); return t && !t.startsWith("@") ? `@${t}` : t; })(),
      phone: str(c && c.phone, 40),
    })).filter((c) => c.name || c.telegram || c.phone),
    cafes: list(r.cafes, 10).map((c) => ({ name: str(c && c.name, 120), note: str(c && c.note, 300), tag: str(c && c.tag, 60) })).filter((c) => c.name),
    routeUrl: /^https:\/\/[^\s"<>]+$/i.test(String(r.routeUrl || "").trim()) ? String(r.routeUrl).trim().slice(0, 300) : "",
    notes: str(r.notes, 600),
  };
}

// ═══ mode "announce" — перший абзац оголошення (v144) ═══════════════
const PLACE_UK = {
  mountain: "гори", lake: "озеро", city: "місто", gorge: "ущелина", forest: "ліс",
  valley: "долина", river: "ріка", museum: "музей", waterfall: "водоспад", bike: "велопоїздка",
};
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const SEASONS = ["зима", "зима", "весна", "весна", "весна", "літо", "літо", "літо", "осінь", "осінь", "осінь", "зима"];
const MAX_STYLE = 3000;

export const SCHEMA_ANNOUNCE = obj({ intro: S });

export function cleanAnnTrip(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const pts = (v, n) => list(v, n).map((p) => ({ name: line(p && p.name, 120), note: line(p && p.note, 200) })).filter((p) => p.name);
  return {
    title: line(r.title, 120),
    subtitle: line(r.subtitle, 200),
    date: isoDate(r.date),
    placeType: Object.prototype.hasOwnProperty.call(PLACE_UK, String(r.placeType || "")) ? String(r.placeType) : "",
    difficulty: DIFFICULTIES.includes(String(r.difficulty || "")) ? String(r.difficulty) : "",
    difficultyNote: line(r.difficultyNote, 400),
    distanceKm: line(r.distanceKm, 12),
    durationHrs: line(r.durationHrs, 40),
    ascentM: line(r.ascentM, 12),
    about: line(r.about, 3000),
    route: pts(r.route, 20),
    bonus: pts(r.bonus, 10),
    cafes: list(r.cafes, 8).map((c) => line(c, 80)).filter(Boolean),
  };
}
// «осінь (жовтень)» — щоб вступ пасував до пори року.
export function seasonOf(date) {
  const m = String(date || "").match(/^\d{4}-(\d{2})-\d{2}$/);
  const i = m ? Number(m[1]) - 1 : -1;
  return i >= 0 && i < 12 ? `${SEASONS[i]} (${MONTHS[i]})` : "";
}
// Поїздка для Claude — звичайним текстом, українською.
export function annFactsText(t) {
  const L = [`Назва: ${t.title}`];
  if (t.subtitle) L.push(`Підзаголовок: ${t.subtitle}`);
  if (t.placeType) L.push(`Тип місця: ${PLACE_UK[t.placeType]}`);
  const season = seasonOf(t.date);
  if (season) L.push(`Пора року: ${season}`);
  const walk = [t.distanceKm && `${t.distanceKm} км`, t.durationHrs, t.ascentM && `підйом ${t.ascentM} м`].filter(Boolean).join(", ");
  if (walk) L.push(`Прогулянка: ${walk}`);
  if (t.difficulty) L.push(`Складність: ${t.difficulty.toLowerCase()}${t.difficultyNote ? ` — ${t.difficultyNote}` : ""}`);
  else if (t.difficultyNote) L.push(`Кому підходить: ${t.difficultyNote}`);
  if (t.about) L.push(`Опис від організатора: ${t.about}`);
  if (t.route.length) L.push(`Точки маршруту:\n${t.route.map((p, i) => `${i + 1}. ${p.name}${p.note ? ` — ${p.note}` : ""}`).join("\n")}`);
  if (t.bonus.length) L.push(`Додатково поруч (за бажанням): ${t.bonus.map((p) => `${p.name}${p.note ? ` — ${p.note}` : ""}`).join("; ")}`);
  if (t.cafes.length) L.push(`Кафе: ${t.cafes.join(", ")}`);
  return L.join("\n");
}

export function systemPromptAnnounce(style) {
  const base = `You write the opening paragraph of a Telegram announcement for Tropa Club — one-day group trips (hikes, lakes, mountains, gorges, old towns) in Bavaria for a Ukrainian-speaking community. Right below your paragraph the app adds every practical detail by itself: date, meeting time and place, trains, distance, duration, route points, what to bring, tickets, number of places, sign-up deadline and the link. Your only job is to make people want to come.

Write the paragraph in Ukrainian:
1. 2–4 sentences, 200–450 characters in total, one paragraph without line breaks.
2. Speak as the organizer to the group: «ми» for what we will do together (пройдемо, побачимо, зупинимось), «ви» when addressing readers. Warm, lively and concrete. No pathos and no clichés like «незабутні враження», «казкова природа», «зарядитися енергією», «не пропустіть».
3. Use ONLY facts from the trip data. Never invent sights, legends, history, distances, prices, opening hours, events, food or weather that are not in the data. If the data is thin, write a short, simple invitation without specifics.
4. Do NOT mention the date, the weekday, any times, trains, prices, tickets, the number of places, the deadline, links or contacts, and do not repeat the numbers for distance, duration or ascent — all of that comes right after your paragraph. Avoid «цієї суботи», «завтра» and the like.
5. At most 1–2 fitting emoji, not at the very start. No hashtags, no Markdown, no title line, no quotation marks around the text.
6. Keep proper names exactly as they are written in the data: German names stay German, Ukrainian names stay Ukrainian.
7. The season is given only so the text suits the time of year; never state weather or colours as a certainty.`;
  if (!style) return base;
  return `${base}

The organizer's own earlier announcements are below. Imitate their tone, sentence length and emoji habits, but take NO facts, names or dates from them:
<<<
${style}
>>>`;
}

// Навіть якщо модель порушить правило, речення з часом, ціною, посиланням
// чи ніком у застосунок не потрапить: ці факти мають іти лише з полів.
const RISKY = /\d{1,2}[:.]\d{2}(?!\d)|€|євро|euro?\b|https?:\/\/|www\.|t\.me\/|@[A-Za-z0-9_]{3,}|⟦URL⟧/i;
export function cleanIntro(s) {
  let t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ");
  t = t.replace(/\*\*|__|`/g, "").replace(/^\s*#+\s*/, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["«“„]+/, "").replace(/["»”]+$/, "").trim();
  // Посилання й числа з крапкою («7.40», «9.5») не розрізаємо на речення:
  // інакше «Збір о 7.40» розпалося б на «о 7.» і «40…» і проскочило б.
  t = t.replace(/(?:https?:\/\/|www\.|t\.me\/)\S*[^\s.,!?…»”)]/gi, "⟦URL⟧").replace(/(\d)\.(\d)/g, "$1\u2024$2");
  const parts = (t.match(/[^.!?…]+(?:[.!?…]+["»”)]*|$)/g) || []).map((p) => p.trim().replace(/\u2024/g, ".")).filter(Boolean);
  let out = "";
  for (const p of parts) {
    if (RISKY.test(p)) continue;
    if ((out ? out.length + 1 : 0) + p.length > 700) break;
    out = out ? `${out} ${p}` : p;
  }
  return out;
}

// ═══ mode "schedule" — розклад DB → поїзди (v144) ════════════════════
const LEG = obj({ from: S, fromTime: S, platform: S, train: S, to: S, toTime: S, toPlatform: S });
export const SCHEMA_SCHEDULE = obj({
  date: S,
  journeys: { type: "array", items: obj({ legs: { type: "array", items: LEG } }) },
  returnFrom: S, returnTime: S, returnPlatform: S,
  notes: S,
});

export function systemPromptSchedule(today, tripDate) {
  return `You read train connections that the organizer of "Tropa Club" (one-day group trips in Bavaria for a Ukrainian-speaking community) copied from Deutsche Bahn — the DB Navigator app (the "Teilen"/share text) or the bahn.de website — and turn them into the trip's train fields (JSON schema).

Rules:
1. Use only what the text states. Never invent trains, times, stations or platforms. Unknown parts stay "".
2. A connection is a ride from a start station to a destination, possibly with changes. Every ride in a train, bus, tram, ship or cable car is one leg, in order. Walking between platforms or stations ("Fußweg", "Umstieg", "zu Fuß", "Übergang", a footpath with minutes) is NOT a leg — skip it.
3. Leg fields: from, to — station names exactly as DB writes them, in German ("München Hbf", "Landsberg(Lech)", "Garmisch-Partenkirchen", "Murnau"); fromTime, toTime — planned times "HH:MM" (if a real-time or delayed time is shown next to the planned one, use the planned one); platform, toPlatform — only the platform number or letter ("27", "5a", "3-4"), "" if not given; train — the line as DB shows it: "RB 6", "RE 70", "ICE 513", "S 8", "Bus 9606", "BRB RB55". If DB shows a line with a train number in brackets ("RB 6 (59457)"), write only the line ("RB 6").
4. journeys — the connections TO the destination, one per connection (for example one from München and one from Augsburg). If the text lists several alternative connections for the same route (search results), take only the first complete one and mention it in notes.
5. The connection BACK — from the destination toward the place where an outward connection started, usually later the same day — is not a journey. Put the first departure of that connection into returnFrom (station), returnTime ("HH:MM") and returnPlatform. Several return options — take the first.
6. date — the travel date as "YYYY-MM-DD" if the text states it, else "". Today is ${today}; a date without a year is the nearest future one.${tripDate ? ` The trip in the app is on ${tripDate}.` : ""}
7. notes — in Ukrainian, 0–2 short sentences for the organizer about things to double-check: replacement bus (SEV, Ersatzverkehr), a reservation requirement, several alternatives in the text, a missing platform, a date different from the trip date. "" if nothing.`;
}

export function cleanSchedule(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    date: isoDate(r.date),
    journeys: list(r.journeys, 6).map((j) => ({ legs: cleanLegs(j && j.legs) })).filter((j) => j.legs.length > 0),
    returnFrom: line(r.returnFrom, 80),
    returnTime: hhmm(r.returnTime),
    returnPlatform: platform(r.returnPlatform),
    notes: str(r.notes, 400),
  };
}

// ═══ mode "route" — точки маршруту (v144) ════════════════════════════
const KINDS_ROUTE = ["hike", "city", "bike"];
const REF_RE = /^(start|end|top|[wspl]\d{1,3})$/;
export const SCHEMA_ROUTE = obj({
  points: { type: "array", items: obj({ ref: S, name: S, note: S, info: S, stopMin: { type: "integer" } }) },
  notes: S,
});

// Кандидати від застосунку — перевірені й підрізані. Теги — лише короткі
// пари «ключ=значення», без зайвого: модель бачить тільки корисне.
export function cleanCandidates(raw) {
  const seen = new Set();
  const out = [];
  for (const c of list(raw, 90)) {
    if (!c || typeof c !== "object") continue;
    const ref = String(c.ref || "").trim();
    if (!REF_RE.test(ref) || seen.has(ref)) continue;
    seen.add(ref);
    const tags = {};
    if (c.tags && typeof c.tags === "object") {
      Object.keys(c.tags).slice(0, 10).forEach((k) => {
        const key = line(k, 30), val = line(c.tags[k], 120);
        if (key && val && /^[a-z_:]+$/i.test(key)) tags[key] = val;
      });
    }
    out.push({
      ref,
      name: line(c.name, 100),
      kind: line(c.kind, 30).toLowerCase(),
      src: ["wpt", "stop", "osm", "anchor"].includes(c.src) ? c.src : "osm",
      km: Math.max(0, Math.round(numOr(c.km, 0) * 100) / 100),
      off: Math.max(0, Math.round(numOr(c.off, 0))),
      ele: Number.isFinite(finite(c.ele)) ? Math.round(finite(c.ele)) : null,
      near: line(c.near, 100),
      wiki: c.wiki === true,
      tags,
    });
  }
  return out;
}

export function cleanRouteStats(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const n = (v) => (Number.isFinite(finite(v)) ? Math.round(finite(v) * 10) / 10 : null);
  return { km: n(r.km), up: n(r.up), down: n(r.down), maxEle: n(r.maxEle), minEle: n(r.minEle), loop: r.loop === true };
}

const KIND_UK = {
  start: "start of the track", end: "end of the track", top: "highest point of the track",
  wpt: "point marked by the organizer in the file", stop: "stop the organizer put on the route",
};
// Кандидати — компактною таблицею: так коротше, ніж JSON, і модель
// бачить усе потрібне в одному рядку.
export function routeFactsText(kind, title, stats, cands, source) {
  const L = [];
  const st = [];
  if (stats.km != null) st.push(`${stats.km} km`);
  if (stats.up != null) st.push(`up ${stats.up} m`);
  if (stats.down != null) st.push(`down ${stats.down} m`);
  if (stats.maxEle != null) st.push(`highest ${stats.maxEle} m`);
  if (stats.loop) st.push("loop (ends where it starts)");
  L.push(`Route type: ${kind === "city" ? "city walk" : kind === "bike" ? "bike ride" : "hike"}${st.length ? ` — ${st.join(", ")}` : ""}.`);
  if (title) L.push(`Trip title in the app: ${title}`);
  if (source === "gmaps") L.push("Source: a Google Maps route; the stops (src stop) are the places the organizer chose — include ALL of them, in order.");
  if (source === "stops") L.push("Source: a file with named points only; these points (src stop) are the places the organizer chose — include ALL of them, in order.");
  L.push("Candidates (ref | km along the route | distance from the track | type | name | elevation | facts):");
  for (const c of cands) {
    const type = c.src === "anchor" ? KIND_UK[c.ref] || c.kind : c.src === "wpt" ? `${KIND_UK.wpt}${c.kind && c.kind !== "wpt" ? `, ${c.kind}` : ""}` : c.src === "stop" ? KIND_UK.stop : c.kind;
    const facts = [];
    if (c.near) facts.push(`near: ${c.near}`);
    if (c.wiki) facts.push("has a Wikipedia article");
    Object.keys(c.tags).forEach((k) => facts.push(`${k}=${c.tags[k]}`));
    L.push([
      c.ref, `${c.km} km`, c.src === "anchor" ? "on track" : `${c.off} m`, type,
      c.name || "(no name)", c.ele != null ? `${c.ele} m` : "", facts.join("; "),
    ].join(" | "));
  }
  return L.join("\n");
}

export function systemPromptRoute() {
  return `You prepare the route points for a trip in the "Tropa Club" app — one-day group trips (hikes, lakes, mountains, old towns) in Bavaria for a Ukrainian-speaking community, many of them beginners. The organizer uploaded a GPS track (GPX/KML) or a Google Maps route. The app has already measured it and found the places near it on OpenStreetMap; they come to you as a numbered list of candidates. Choose the points for the route timeline and describe them the way the app does.

How the app shows a route point: a bold name, a short grey note under it, an optional yellow "info" box with practical facts, and a planned time that the app calculates itself from the distance, the climbs and the stops you choose.

Route points the organizer wrote himself (follow this style):
- "Олімпійський трамплін" — "Точка старту, є туалети та кіоск"
- "Вхід у Партнахкламм" — "Вузькі тунелі — обережно"
- "Альпійська галявина" — "Привал, обід із собою, краєвид"
- "Ринкова площа (Hauptmarkt)" — "Гарний фонтан, ринок"
- "Імператорський замок" — "Краєвид на дахи старого міста"
- "Повернення до станції" — "Кільце замкнулось"

Rules:
1. Choose 4–9 points for a hike or bike ride, 5–10 for a city walk, in route order (when the organizer's stops must all be included, take all of them and add at most 3 notable places between them). Always include the beginning and the end of the route — the anchor "start"/"end" or a candidate right there (a station, a car park, the first or last stop). For a loop the last point is "Повернення до …". Pick what matters to the group: the station at the start, huts and places to eat, the summit or highest point, viewpoints, lakes, waterfalls, gorges, chapels, castles and sights. A long stretch with nothing notable needs no point. Stops or file points chosen by the organizer (src stop / wpt), if the list says so, must all be included.
2. Use only refs from the candidate list, each at most once. Never invent places. If an anchor and a candidate are the same place (the highest point next to a peak, the start next to a station), use only one of them — the named candidate.
3. name — Ukrainian. Translate descriptive words (See → озеро, Hütte/Haus → хатина, Alm → альпійське пасовище, Kapelle → каплиця, Kirche → церква, Aussichtspunkt → оглядовий майданчик, Wasserfall → водоспад, Klamm/Schlucht → ущелина, Bahnhof → вокзал, Gipfel → вершина). Proper names of natural places and sights go in Ukrainian letters, with the German original in parentheses when people will look for it on signs or maps: "Озеро Айбзеє", "Вершина Герцогштанд (Herzogstand)", "Ринкова площа (Hauptmarkt)". Huts, restaurants, cafés and stations keep their German name after a Ukrainian word: "Хатина Herzogstandhaus", "Ресторан Fischer am See", "Вокзал Kochel". An unnamed candidate gets a plain descriptive name ("Оглядовий майданчик", "Перевал"). Up to ~45 characters.
4. note — Ukrainian, up to ~70 characters: what the place is and what the group does there, like the examples: "Старт біля вокзалу", "Вершина 1731 м — панорама на озера", "Привал, обід у хатині", "Фото біля водоспаду", "Фініш, звідси поїзд додому". Use only facts from the data (type, elevation, tags) or facts that are widely known and certain about famous places. No prices, opening hours or events in the note.
5. info — only facts given in the candidate's tags, in Ukrainian; for example opening hours converted from OSM syntax ("Відчинено: щодня 9:00–18:00"; "Mo-Fr" → "пн–пт") or "Вхід платний" for fee=yes. Never invent. "" if there is nothing.
6. stopMin — how long the group stays at the point, in minutes: 0 for the start, the finish and places we only pass; 10–15 for a viewpoint or photo stop; 30–60 for the main break (lunch at a hut or restaurant, a picnic at the summit or a lake) — usually one main break per hike; city sights 10–30, a museum visit about 60.
7. notes — Ukrainian, 0–2 short sentences for the organizer about something to check: for example, the track starts far from any station, the file has no heights, or the route crosses a road without a path. "" if nothing.`;
}

export function cleanRoutePoints(raw, cands) {
  const r = raw && typeof raw === "object" ? raw : {};
  const known = new Set(cands.map((c) => c.ref));
  const used = new Set();
  const points = [];
  const must = cands.filter((c) => c.src === "stop").length;
  for (const p of list(r.points, Math.max(14, must + 4))) {
    const ref = String((p && p.ref) || "").trim();
    if (!known.has(ref) || used.has(ref)) continue;
    const name = line(p.name, 80);
    if (!name) continue;
    used.add(ref);
    const stop = Math.round(Math.min(120, Math.max(0, numOr(p.stopMin, 0))) / 5) * 5;
    points.push({ ref, name, note: line(p.note, 160), info: str(p.info, 300), stopMin: stop });
  }
  return { points, notes: str(r.notes, 400) };
}

// ═══ mode "gmaps" — посилання Google Maps → зупинки (v144) ══════════
// Короткі посилання (maps.app.goo.gl) розгортаємо самі: браузер цього не
// може (Google не дає читати чужим сайтам). Ходимо лише на адреси Google.
const GOOGLE_TLD = "(com|de|at|ch|it|fr|pl|cz|nl|be|es|pt|dk|se|no|fi|hu|sk|si|hr|ro|bg|gr|ie|lu|li|ua|com\\.ua|co\\.uk|ca|com\\.au|us)";
const GOOGLE_HOST = new RegExp(`^(maps\\.app\\.goo\\.gl|goo\\.gl|(www\\.|maps\\.|consent\\.)?google\\.${GOOGLE_TLD})$`, "i");
export function googleUrlOk(href) {
  try {
    const u = new URL(String(href || "").trim());
    return u.protocol === "https:" && GOOGLE_HOST.test(u.hostname) ? u : null;
  } catch { return null; }
}

// Поле data= у посиланні маршруту: «!4m14!4m13!1m5!1m1!1s…!2m2!1d11.57!2d48.13!1m5…!3e2».
// Кожне «Nm<k>» — вкладене повідомлення з k нащадками. Зупинка — «1m<k>»,
// її координати — «1d<довгота>» і «2d<широта>», спосіб пересування — «3e<n>».
export function dataWaypoints(data) {
  const toks = String(data || "").split("!").filter(Boolean).map((x) => {
    const m = x.match(/^(\d+)([a-z])(.*)$/);
    return m ? { f: Number(m[1]), t: m[2], v: m[3] } : null;
  });
  const span = (i) => (toks[i] && toks[i].t === "m" ? Number(toks[i].v) || 0 : 0);
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (!tk || tk.t !== "m") continue;
    const end = Math.min(toks.length, i + 1 + span(i));
    const kids = [];
    for (let j = i + 1; j < end; j += 1 + span(j)) kids.push(j);
    const wps = kids.filter((j) => toks[j] && toks[j].f === 1 && toks[j].t === "m");
    if (wps.length < 2) continue;
    const modeIdx = kids.find((j) => toks[j] && toks[j].f === 3 && toks[j].t === "e");
    const points = wps.map((j) => {
      const sub = toks.slice(j + 1, j + 1 + span(j));
      const lng = sub.find((s) => s && s.f === 1 && s.t === "d");
      const lat = sub.find((s) => s && s.f === 2 && s.t === "d");
      const a = lat ? parseFloat(lat.v) : NaN, b = lng ? parseFloat(lng.v) : NaN;
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? { lat: a, lng: b } : null;
    });
    return { points, travel: modeIdx != null ? Number(toks[modeIdx].v) : null };
  }
  return { points: [], travel: null };
}
const TRAVEL = { 0: "driving", 1: "bicycling", 2: "walking", 3: "transit" };
const COORDS_RE = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/;
const plusDecode = (s) => { try { return decodeURIComponent(String(s).replace(/\+/g, " ")); } catch { return String(s).replace(/\+/g, " "); } };

// Розгорнуте посилання → { stops: [{ name, lat, lng }], travel } або { error, code }.
export function parseGmapsUrl(href) {
  let u;
  try { u = new URL(href); } catch { return { code: "badurl" }; }
  const p = u.pathname;
  if (/^\/maps\/d\//.test(p) || /mymaps/i.test(u.hostname)) return { code: "mymaps" };
  // Формат «?api=1&origin=…&destination=…&waypoints=a|b».
  if (u.searchParams.get("api") === "1" && /\/maps\/dir/.test(p)) {
    const names = [u.searchParams.get("origin"), ...String(u.searchParams.get("waypoints") || "").split("|"), u.searchParams.get("destination")]
      .map((x) => String(x || "").trim()).filter(Boolean);
    const stops = names.map((n) => { const m = n.match(COORDS_RE); return m ? { name: "", lat: +m[1], lng: +m[2] } : { name: line(n, 120), lat: null, lng: null }; });
    const tm = String(u.searchParams.get("travelmode") || "");
    return stops.length >= 2 ? { stops, travel: tm } : { code: "notroute" };
  }
  const m = p.match(/\/maps\/dir\/(.*)$/);
  if (!m) return { code: /\/maps\/(place|search)\//.test(p) ? "notroute" : "badurl" };
  const segs = m[1].split("/");
  const dataSeg = segs.find((s) => s.startsWith("data="));
  const data = dataSeg ? dataSeg.slice(5) : "";
  // Зупинки — до першого «@…» (місце карти); службові відрізки на зразок
  // «am=t» — не зупинки.
  const names = [];
  for (const s of segs) {
    if (s.startsWith("@") || s.startsWith("data=")) break;
    if (/^[a-z]{1,5}=/i.test(s)) continue;
    names.push(plusDecode(s).trim());
  }
  // Порожній відрізок — «Моє місцезнаходження»: це місце, де стояв телефон
  // організатора, а не точка маршруту. Його не беремо навіть з координатами.
  const wp = dataWaypoints(data);
  const stops = [];
  let dropped = 0;
  const named = names.filter(Boolean);
  // Координати з data= ідуть у тому самому порядку, що й зупинки: або
  // разом із «Моїм місцезнаходженням» (порожній відрізок), або без нього.
  const zip = wp.points.length === names.length ? names : wp.points.length === named.length ? named : null;
  if (zip) {
    zip.forEach((n, i) => {
      if (!n) { dropped++; return; }
      const c = n.match(COORDS_RE);
      if (c) stops.push({ name: "", lat: +c[1], lng: +c[2] });
      else stops.push({ name: line(n, 120), lat: wp.points[i] ? wp.points[i].lat : null, lng: wp.points[i] ? wp.points[i].lng : null });
    });
    if (zip === named) dropped += names.length - named.length;
  } else {
    names.forEach((n) => {
      if (!n) { dropped++; return; }
      const c = n.match(COORDS_RE);
      stops.push(c ? { name: "", lat: +c[1], lng: +c[2] } : { name: line(n, 120), lat: null, lng: null });
    });
  }
  if (stops.length < 2) return { code: "notroute" };
  return { stops: stops.slice(0, 25), travel: TRAVEL[wp.travel] || "", dropped };
}

// Йдемо за переадресаціями Google (не більше шести) і лише по адресах Google.
export async function expandGoogleUrl(href, fetchImpl = fetch, deadline = Infinity) {
  let u = googleUrlOk(href);
  if (!u) return { code: "badurl" };
  for (let hop = 0; hop < 6; hop++) {
    if (Date.now() > deadline) return { code: "fetch" };
    if (/^\/maps\//.test(u.pathname) && !/goo\.gl$/i.test(u.hostname)) return { url: u.href };
    // Сторінка згоди Google (Європа): справжня адреса — у параметрі continue.
    if (/^consent\./i.test(u.hostname) && u.searchParams.get("continue")) {
      const next = googleUrlOk(u.searchParams.get("continue"));
      if (!next) return { code: "badurl" };
      u = next; continue;
    }
    let r;
    try {
      r = await fetchImpl(u.href, { method: "GET", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (TropaClub route import)", "Accept-Language": "de,en;q=0.8" }, signal: AbortSignal.timeout(8000) });
    } catch { return { code: "fetch" }; }
    const hdr = (k) => (r.headers && (r.headers.get ? r.headers.get(k) : r.headers[k])) || "";
    const loc = hdr("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      let next;
      try { next = googleUrlOk(new URL(loc, u.href).href); } catch { next = null; }
      if (!next) return { code: "badurl" };
      u = next; continue;
    }
    // Іноді замість переадресації Google віддає сторінку, що переходить
    // далі сама (meta refresh чи скрипт). Шукаємо в ній адресу маршруту.
    if (r.status === 200 && /html/i.test(hdr("content-type")) && typeof r.text === "function") {
      let html = "";
      try { html = String(await r.text()).slice(0, 300000); } catch { html = ""; }
      const found = html.replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&")
        .match(/https:\/\/(?:www\.|maps\.)?google\.[a-z.]{2,6}\/maps\/[^"'\s<>\\]+/i);
      const next = found ? googleUrlOk(found[0]) : null;
      if (next) { u = next; continue; }
    }
    return { code: "fetch" };
  }
  return { code: "fetch" };
}

// ═══ Claude ═════════════════════════════════════════════════════════
export function claudeError(status, j) {
  const msg = String((j && j.error && j.error.message) || "");
  if (status === 401 || status === 403) return { code: "key", error: "ключ Claude неправильний або видалений — створи новий у platform.claude.com і заміни ANTHROPIC_API_KEY у Vercel" };
  if (/credit balance/i.test(msg)) return { code: "credit", error: "на рахунку Claude закінчились кошти — поповни: platform.claude.com → Settings → Billing" };
  if (status === 400 && /spend limit|usage limit/i.test(msg)) return { code: "limit", error: "досягнуто ліміту витрат, який стоїть у Claude Console (Settings → Billing → Spend limits)" };
  if (status === 429) return { code: "rate", error: "забагато запитів до Claude — спробуй за хвилину" };
  if (status === 529 || status >= 500) return { code: "busy", error: "Claude зараз перевантажений — спробуй за хвилину" };
  return { code: "claude", error: `Claude відповів ${status}${msg ? `: ${msg.slice(0, 160)}` : ""}` };
}

function costOf(model, usage) {
  const p = PRICES[model] || PRICES[String(model || "").replace(/-\d{8}$/, "")];
  if (!p || !usage) return null;
  const usd = ((Number(usage.input_tokens) || 0) * p[0] + (Number(usage.output_tokens) || 0) * p[1]) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

// Один виклик Claude зі схемою відповіді. Якщо основна модель не прийняла
// запиту (400/404 — не через гроші чи ліміт), ще раз — запасною, без effort.
// Повертає { raw } або { status, body: { error, code } }.
async function askClaude(E, task, started) {
  const send = async (model, effort) => {
    const left = BUDGET_MS - (Date.now() - started);
    if (left < 4000) return { status: 0, timeout: true };
    const output = { format: { type: "json_schema", schema: task.schema } };
    if (effort) output.effort = effort;
    const r = await fetch(`${API}/messages`, {
      method: "POST",
      headers: { "x-api-key": E.claude, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: task.maxTokens || 4000,
        system: task.system,
        messages: [{ role: "user", content: task.user }],
        output_config: output,
      }),
      signal: AbortSignal.timeout(left - 1500),
    });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    return { status: r.status, j, model };
  };
  let a = await send(E.model, E.model === FALLBACK_MODEL ? null : task.effort);
  if (a.timeout) return { status: 502, body: { error: "Claude не відповів вчасно — спробуйте ще раз", code: "timeout" } };
  if ((a.status === 400 || a.status === 404) && E.model !== FALLBACK_MODEL && !["credit", "limit"].includes(claudeError(a.status, a.j).code)) {
    a = await send(FALLBACK_MODEL, null);
    if (a.timeout) return { status: 502, body: { error: "Claude не відповів вчасно — спробуйте ще раз", code: "timeout" } };
  }
  if (a.status !== 200 || !a.j) return { status: 502, body: claudeError(a.status, a.j) };
  if (a.j.stop_reason === "refusal") return { status: 502, body: { error: "Claude відмовився це опрацювати", code: "refusal" } };
  const block = (a.j.content || []).find((b) => b && b.type === "text");
  let raw = null;
  try { raw = JSON.parse(String((block && block.text) || "")); } catch { raw = null; }
  if (!raw) {
    return { status: 502, body: { error: a.j.stop_reason === "max_tokens" ? "відповідь Claude обірвалась — спробуйте ще раз" : "Claude повернув незрозумілу відповідь — спробуйте ще раз", code: "parse" } };
  }
  const usage = a.j.usage || {};
  const model = a.j.model || a.model;
  return { raw, meta: { model, usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 }, costUsd: costOf(model, usage) } };
}

// ── Ключ Claude зі змінних середовища ───────────────────────────────
// Основна назва — ANTHROPIC_API_KEY. На випадок описки — кілька схожих
// назв, а далі будь-яка змінна, значення якої схоже на ключ Claude
// («sk-ant-…»). Повертає { key, from }, де from — НАЗВА змінної.
const KEY_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_KEY", "CLAUDE_KEY", "ANTROPIC_API_KEY", "ANTHROPHIC_API_KEY", "ANTHROPIC_APIKEY"];
const cleanKey = (v) => String(v == null ? "" : v).trim().replace(/^["'`]+|["'`]+$/g, "").trim();
export function findKey(env = process.env) {
  const names = Object.keys(env);
  for (const want of KEY_NAMES) {
    const name = names.find((n) => n.trim().toUpperCase() === want);
    if (name && cleanKey(env[name])) return { key: cleanKey(env[name]), from: name };
  }
  const byValue = names.find((n) => /^sk-ant-/.test(cleanKey(env[n])));
  if (byValue) return { key: cleanKey(env[byValue]), from: byValue };
  return { key: "", from: "" };
}
// Для перевірки, коли ключа немає: схожі назви й порожні змінні — лише
// назви, значень звідси не видно ніколи.
export function keyHints(env = process.env) {
  const names = Object.keys(env);
  return {
    similar: names.filter((n) => /ANTH?R?OP|CLAUDE/i.test(n) && n !== "CLAUDE_MODEL").slice(0, 10),
    empty: names.filter((n) => KEY_NAMES.includes(n.trim().toUpperCase()) && !cleanKey(env[n])),
  };
}
const deployInfo = (env = process.env) => [env.VERCEL_ENV, String(env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7), String(env.VERCEL_GIT_COMMIT_MESSAGE || "").replace(/\s+/g, " ").slice(0, 60)].filter(Boolean).join(" · ");

// true — PIN правильний, false — ні, null — базу не вдалося спитати.
async function pinOk(E, pin) {
  if (!pin) return false;
  let r;
  try {
    r = await fetch(`${E.url}/rest/v1/rpc/check_pin`, {
      method: "POST",
      headers: { apikey: E.key, Authorization: `Bearer ${E.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pin: String(pin) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { return null; }
  if (!r.ok) return null;
  let v = null;
  try { v = await r.json(); } catch { return null; }
  return v === true;
}

const cleanText = (v) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
const GMAPS_ERRORS = {
  badurl: "це не посилання Google Maps на маршрут",
  notroute: "у посиланні одне місце, а не маршрут — у Google Maps прокладіть маршрут («Маршрути», кілька зупинок) і поділіться ним",
  mymaps: "це карта My Maps — експортуйте її у файл KML (⋮ → «Експортувати в KML/KMZ», галочка «KML») і завантажте файл",
  fetch: "Google не віддав маршрут за цим посиланням — спробуйте повне посилання з адресного рядка браузера",
};

export default async function handler(req, res) {
  const started = Date.now();
  const K = findKey();
  const E = {
    url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    claude: K.key,
    model: String(process.env.CLAUDE_MODEL || "").trim() || DEFAULT_MODEL,
  };

  // Перевірка без витрат: GET /v1/models/<модель> токенів не витрачає.
  if (req.method === "GET") {
    const report = { "версія": VERSION, "що вміє": "оголошення для Telegram · розклад з DB · точки маршруту (GPX/KML, Google Maps)", "модель": E.model };
    report["ключ Claude"] = !K.key ? "немає"
      : K.from === "ANTHROPIC_API_KEY" ? "є"
      : `є — у змінній «${K.from}» (працює; можна залишити так)`;
    if (!K.key) {
      const h = keyHints();
      if (h.empty.length) report["змінна є, але порожня"] = h.empty.join(", ");
      report["схожі назви змінних"] = h.similar.length ? h.similar.join(", ") : "жодної";
      report["що перевірити"] = "Vercel → саме цей проєкт → Settings → Environment Variables: назва ANTHROPIC_API_KEY, у Environments є Production. Після Save: Deployments → верхнє з позначкою Production → ⋯ → Redeploy і дочекатися Ready.";
    }
    report["розгортання"] = deployInfo() || "невідомо";
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) report["основна адреса проєкту"] = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (E.claude) {
      try {
        const r = await fetch(`${API}/models/${encodeURIComponent(E.model)}`, {
          headers: { "x-api-key": E.claude, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15000),
        });
        report["ключ працює"] = r.ok ? "так"
          : r.status === 401 || r.status === 403 ? "ні — ключ неправильний або видалений"
          : r.status === 404 ? `ключ так, але моделі ${E.model} немає — прибери CLAUDE_MODEL у Vercel`
          : `Claude відповів ${r.status}`;
      } catch (e) {
        report["ключ працює"] = `не вдалося перевірити: ${String((e && e.message) || e).slice(0, 100)}`;
      }
    }
    report["база (для PIN)"] = E.url && E.key ? "є" : "немає SUPABASE_URL чи SUPABASE_SERVICE_ROLE_KEY";
    res.status(200).json(report);
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "лише POST" }); return; }
  if (!E.url || !E.key) { res.status(500).json({ error: "сервер не налаштований: немає змінних бази у Vercel", code: "env" }); return; }
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  const mode = String(body.mode || "trip");

  try {
    const pinState = await pinOk(E, body.pin);
    if (pinState === null) { res.status(502).json({ error: "не вдалося перевірити PIN — база не відповіла, спробуйте ще раз", code: "db" }); return; }
    if (!pinState) { res.status(403).json({ error: "потрібен PIN організатора", code: "pin" }); return; }

    // Посилання Google Maps — без Claude.
    if (mode === "gmaps") {
      const x = await expandGoogleUrl(String(body.url || ""), fetch, started + BUDGET_MS - 9000);
      if (x.code) { res.status(400).json({ error: GMAPS_ERRORS[x.code], code: x.code }); return; }
      const p = parseGmapsUrl(x.url);
      if (p.code) { res.status(400).json({ error: GMAPS_ERRORS[p.code], code: p.code }); return; }
      res.status(200).json({ ok: true, stops: p.stops, travel: p.travel, dropped: p.dropped || 0, url: x.url.slice(0, 2000) });
      return;
    }

    if (!["trip", "announce", "schedule", "route"].includes(mode)) { res.status(400).json({ error: "невідома дія", code: "mode" }); return; }
    if (!E.claude) { res.status(500).json({ error: "немає ключа Claude: додай ANTHROPIC_API_KEY у Vercel і зроби Redeploy", code: "nokey" }); return; }

    if (mode === "announce") {
      const trip = cleanAnnTrip(body.trip);
      if (!trip.title) { res.status(400).json({ error: "у поїздки немає назви", code: "trip" }); return; }
      const style = cleanText(body.style).slice(0, MAX_STYLE);
      const a = await askClaude(E, {
        schema: SCHEMA_ANNOUNCE, system: systemPromptAnnounce(style), effort: "medium", maxTokens: 3000,
        user: `Trip data:\n<<<\n${annFactsText(trip)}\n>>>`,
      }, started);
      if (!a.raw) { res.status(a.status).json(a.body); return; }
      const intro = cleanIntro(a.raw.intro);
      if (!intro) { res.status(502).json({ error: "Claude не впорався з вступом — спробуйте ще раз", code: "empty" }); return; }
      res.status(200).json({ ok: true, intro, ...a.meta });
      return;
    }

    if (mode === "schedule") {
      const text = cleanText(body.text);
      if (text.length < 15) { res.status(400).json({ error: "замало тексту — вставте розклад повністю", code: "short" }); return; }
      if (text.length > MAX_TEXT) { res.status(400).json({ error: `задовгий текст — до ${MAX_TEXT} знаків`, code: "long" }); return; }
      const a = await askClaude(E, {
        schema: SCHEMA_SCHEDULE, system: systemPromptSchedule(berlinToday(), isoDate(body.tripDate)), effort: "low", maxTokens: 4000,
        user: `Copied from Deutsche Bahn:\n<<<\n${text}\n>>>`,
      }, started);
      if (!a.raw) { res.status(a.status).json(a.body); return; }
      res.status(200).json({ ok: true, ...cleanSchedule(a.raw), ...a.meta });
      return;
    }

    if (mode === "route") {
      const cands = cleanCandidates(body.candidates);
      if (cands.length < 2) { res.status(400).json({ error: "у маршруті замало точок", code: "short" }); return; }
      const kind = KINDS_ROUTE.includes(body.kind) ? body.kind : "hike";
      const source = ["gpx", "kml", "geojson", "gmaps", "stops"].includes(body.source) ? body.source : "gpx";
      const a = await askClaude(E, {
        schema: SCHEMA_ROUTE, system: systemPromptRoute(), effort: "low", maxTokens: 4000,
        user: routeFactsText(kind, line(body.title, 80), cleanRouteStats(body.stats), cands, source),
      }, started);
      if (!a.raw) { res.status(a.status).json(a.body); return; }
      const out = cleanRoutePoints(a.raw, cands);
      if (out.points.length < 2) { res.status(502).json({ error: "Claude не обрав точок — спробуйте ще раз", code: "empty" }); return; }
      res.status(200).json({ ok: true, ...out, ...a.meta });
      return;
    }

    // mode "trip" — як у v143.
    const text = cleanText(body.text);
    if (text.length < 20) { res.status(400).json({ error: "замало тексту — вставте оголошення повністю", code: "short" }); return; }
    if (text.length > MAX_TEXT) { res.status(400).json({ error: `задовгий текст — до ${MAX_TEXT} знаків`, code: "long" }); return; }
    const a = await askClaude(E, {
      schema: SCHEMA_TRIP, system: systemPromptTrip(berlinToday()), effort: "low", maxTokens: 8000,
      user: `Announcement:\n<<<\n${text}\n>>>`,
    }, started);
    if (!a.raw) { res.status(a.status).json(a.body); return; }
    res.status(200).json({ ok: true, fields: cleanFields(a.raw), ...a.meta });
  } catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    res.status(502).json({ error: timeout ? "Claude не відповів вчасно — спробуйте ще раз" : String((e && e.message) || e).slice(0, 160), code: timeout ? "timeout" : "server" });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
