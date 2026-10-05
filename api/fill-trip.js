// ═══ Tropa Club · api/fill-trip.js · ВЕРСІЯ f1 ═══
// ═══════════════════════════════════════════════════════════════════
// Заповнити поїздку з тексту оголошення (автоматизація №4)
//
// НАВІЩО
// Оголошення поїздки організатор уже пише в Telegram. Тепер той самий
// текст можна вставити в редактор поїздки — і Claude розкладе його по
// полях: назва, дата, час і місце збору, поїзди, маршрут, речі, дедлайн.
// Нічого не зберігається саме: організатор перевіряє поля й натискає
// «Зберегти поїздку», як завжди.
//
// ЯК ПРАЦЮЄ
//  • POST { pin, text } — лише з PIN організатора (перевірка через
//    check_pin у Supabase), інакше будь-хто міг би витрачати платний ключ.
//    Сервер питає Claude (Messages API) зі схемою відповіді (structured
//    outputs) і віддає застосунку перевірені поля.
//  • GET — перевірка без витрат: чи є ключ, чи він дійсний і чи є модель.
//
// ВАРТІСТЬ
// Claude Sonnet 5.5 — $2 за мільйон вхідних і $10 за мільйон вихідних
// токенів (жовтень 2026). Одне оголошення — кілька тисяч токенів, тобто
// приблизно 1–3 центи. Кошти — з передоплати в Claude Console
// (platform.claude.com → Settings → Billing); там же можна поставити
// місячний ліміт витрат.
//
// ЗМІННІ СЕРЕДОВИЩА (Vercel → Settings → Environment Variables)
//  • ANTHROPIC_API_KEY — ключ із platform.claude.com → Settings → API keys.
//    Живе ЛИШЕ тут. У код, у GitHub і в чати його не вставляємо.
//  • CLAUDE_MODEL — необов'язково; інша модель, якщо колись знадобиться.
//  • SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — ті самі, що вже є.
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

export const VERSION = "f1";
const API = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-sonnet-5-5";
// Запасна модель: якщо основна не прийме параметрів запиту (400) — ще раз
// простішим запитом, щоб кнопка не ламалась через зміни в Claude API.
const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
// Ціни за мільйон токенів (вхід / вихід), $ — лише щоб показати, скільки
// коштував виклик. Невідома модель — вартість просто не показується.
const PRICES = {
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-haiku-4-5": [1, 5],
  "claude-opus-5-5": [4, 20],
};
const MAX_TEXT = 12000;

const PLACE_TYPES = ["mountain", "lake", "city", "gorge", "forest", "valley", "river", "museum", "waterfall", "bike"];
const DIFFICULTIES = ["Легкий", "Середній", "Складний"];

const S = { type: "string" };
const obj = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
// Схема відповіді. Усі поля обов'язкові (невідоме — "" чи []): так модель
// не пропускає полів, а схема вкладається в обмеження structured outputs.
export const SCHEMA = obj({
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

const WD = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
// Сьогоднішня дата в Берліні: «2026-10-05».
export function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
// Календар на 150 днів уперед: модель бере дні тижня звідси, а не рахує сама.
export function calendar(today, days = 150) {
  const [y, m, d] = today.split("-").map(Number);
  const out = [];
  for (let i = 0; i < days; i++) {
    const x = new Date(Date.UTC(y, m - 1, d + i));
    out.push(`${x.toISOString().slice(0, 10)} ${WD[x.getUTCDay()]}`);
  }
  return out.join("\n");
}

export function systemPrompt(today) {
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

// ── Перевірка й чистка відповіді ────────────────────────────────────
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);
function hhmm(v) {
  const m = String(v || "").match(/^\s*(\d{1,2})[:.](\d{2})\s*$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
function isoDate(v) {
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
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const platform = (v) => str(v, 12).replace(/^(колія|колiя|путь|gleis|platform|kol\.?)\s*/i, "");

export function cleanFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const f = {
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
    journeys: list(r.journeys, 6).map((j) => ({
      legs: list(j && j.legs, 8).map((l) => ({
        from: str(l && l.from, 80), fromTime: hhmm(l && l.fromTime), platform: platform(l && l.platform),
        train: str(l && l.train, 30), to: str(l && l.to, 80), toTime: hhmm(l && l.toTime), toPlatform: platform(l && l.toPlatform),
        transfer: "",
      })).filter((l) => l.from || l.fromTime || l.train || l.to || l.toTime),
    })).filter((j) => j.legs.length > 0),
    returnFrom: str(r.returnFrom, 80),
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
  return f;
}

// ── Помилки Claude людською мовою ───────────────────────────────────
export function claudeError(status, j) {
  const msg = String((j && j.error && j.error.message) || "");
  if (status === 401 || status === 403) return { code: "key", error: "ключ Claude неправильний або видалений — створи новий у platform.claude.com і заміни ANTHROPIC_API_KEY у Vercel" };
  if (/credit balance/i.test(msg)) return { code: "credit", error: "на рахунку Claude закінчились кошти — поповни: platform.claude.com → Settings → Billing" };
  if (status === 400 && /spend limit|usage limit/i.test(msg)) return { code: "limit", error: "досягнуто ліміту витрат, який стоїть у Claude Console (Settings → Billing → Spend limits)" };
  if (status === 429) return { code: "rate", error: "забагато запитів до Claude — спробуй за хвилину" };
  if (status === 529 || status >= 500) return { code: "busy", error: "Claude зараз перевантажений — спробуй за хвилину" };
  return { code: "claude", error: `Claude відповів ${status}${msg ? `: ${msg.slice(0, 160)}` : ""}` };
}

async function askClaude(key, model, text, today, effort) {
  const output = { format: { type: "json_schema", schema: SCHEMA } };
  if (effort) output.effort = "low";
  const r = await fetch(`${API}/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: systemPrompt(today),
      messages: [{ role: "user", content: `Announcement:\n<<<\n${text}\n>>>` }],
      output_config: output,
    }),
    signal: AbortSignal.timeout(50000),
  });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return { status: r.status, j };
}

function costOf(model, usage) {
  const p = PRICES[model] || PRICES[String(model || "").replace(/-\d{8}$/, "")];
  if (!p || !usage) return null;
  const usd = ((Number(usage.input_tokens) || 0) * p[0] + (Number(usage.output_tokens) || 0) * p[1]) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

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

export default async function handler(req, res) {
  const E = {
    url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    claude: String(process.env.ANTHROPIC_API_KEY || "").trim(),
    model: String(process.env.CLAUDE_MODEL || "").trim() || DEFAULT_MODEL,
  };

  // Перевірка без витрат: GET /v1/models/<модель> токенів не витрачає.
  if (req.method === "GET") {
    const report = { "версія": VERSION, "модель": E.model, "ключ Claude": E.claude ? "є" : "немає — додай ANTHROPIC_API_KEY у Vercel" };
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

  try {
    const pinState = await pinOk(E, body.pin);
    if (pinState === null) { res.status(502).json({ error: "не вдалося перевірити PIN — база не відповіла, спробуйте ще раз", code: "db" }); return; }
    if (!pinState) { res.status(403).json({ error: "потрібен PIN організатора", code: "pin" }); return; }
    if (!E.claude) { res.status(500).json({ error: "немає ключа Claude: додай ANTHROPIC_API_KEY у Vercel і зроби Redeploy", code: "nokey" }); return; }
    const text = String(body.text == null ? "" : body.text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    if (text.length < 20) { res.status(400).json({ error: "замало тексту — вставте оголошення повністю", code: "short" }); return; }
    if (text.length > MAX_TEXT) { res.status(400).json({ error: `задовгий текст — до ${MAX_TEXT} знаків`, code: "long" }); return; }

    const today = berlinToday();
    let model = E.model;
    let a = await askClaude(E.claude, model, text, today, model !== FALLBACK_MODEL);
    // Запит не підійшов моделі (змінились параметри API) або такої моделі
    // вже немає — ще раз простішим запитом до запасної.
    if ((a.status === 400 || a.status === 404) && model !== FALLBACK_MODEL && !["credit", "limit"].includes(claudeError(a.status, a.j).code)) {
      model = FALLBACK_MODEL;
      a = await askClaude(E.claude, model, text, today, false);
    }
    if (a.status !== 200 || !a.j) { const er = claudeError(a.status, a.j); res.status(502).json(er); return; }
    if (a.j.stop_reason === "refusal") { res.status(502).json({ error: "Claude відмовився розбирати цей текст", code: "refusal" }); return; }
    const block = (a.j.content || []).find((b) => b && b.type === "text");
    let raw = null;
    try { raw = JSON.parse(String((block && block.text) || "")); } catch { raw = null; }
    if (!raw) {
      res.status(502).json({ error: a.j.stop_reason === "max_tokens" ? "відповідь Claude обірвалась — скоротіть текст" : "Claude повернув незрозумілу відповідь — спробуйте ще раз", code: "parse" });
      return;
    }
    const usage = a.j.usage || {};
    res.status(200).json({
      ok: true, fields: cleanFields(raw), model: a.j.model || model,
      usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 },
      costUsd: costOf(a.j.model || model, usage),
    });
  } catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    res.status(502).json({ error: timeout ? "Claude не відповів вчасно — спробуйте ще раз" : String((e && e.message) || e).slice(0, 160), code: timeout ? "timeout" : "server" });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
