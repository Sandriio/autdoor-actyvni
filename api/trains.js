// ═══ Tropa Club · api/trains.js · ВЕРСІЯ t2 ═══
// t2 — чесніша звірка (після поїздки до Schongau, де «✓ за розкладом DB»
//      стояло на маршруті з поїздом, якого в DB уже не було):
//      • автобус заміни («Ersatzbus RB67», «SEV») і будь-який «…bus» — не
//        поїзд: стан «nonrail», а не звірка з першим-ліпшим RB67;
//      • станції з «am Lech», «(Oberbay)», «(Allgäu)» знаходяться:
//        «Landsberg am Lech» = «Landsberg(Lech)», «Weilheim» =
//        «Weilheim(Oberbay)»; з кількох однойменних — баварська;
//      • той самий поїзд, що тепер їде о іншій хвилині (до ±30 хв, у тому
//        ж напрямку), — «інший час» з новим часом, а не «немає»;
//      • поїзд, що за розкладом не їде до станції пересадки, — «не доїде»;
//      • прибуття звіряється на станції призначення: зсув від 2 хв —
//        «інший час прибуття»; пересадка, на яку тепер не встигнути, —
//        у списку transfers;
//      • 16–18 год до відправлення без збігу — «ще рано», а не «невідомо»;
//      • розклад DB незмінний, тож години розкладу пам'ятаються 6 годин.
// t1 — перша версія: звірка поїздів поїздки з табло Deutsche Bahn.
//      Автобуси, канатні дороги й кораблі не звіряються: їх немає в DB.
// ═══════════════════════════════════════════════════════════════════
// СТАН ПОЇЗДІВ ЗА ДАНИМИ DEUTSCHE BAHN
//
// НАВІЩО
// Поїзди в поїздці організатор вписує вручну. Напередодні й у день
// поїздки цей сервер звіряє їх з офіційним табло DB: чи поїзд за
// розкладом, чи запізнюється, чи змінилась колія, чи його скасували.
// Застосунок показує це біля поїзда в «Як добираємось», а годинник
// сповіщень (push-cron) пише організаторові, якщо щось змінилось.
//
// ДЖЕРЕЛО — офіційне API «Timetables» з DB API Marketplace
// (developers.deutschebahn.com). Безкоштовний план: 60 запитів на
// хвилину. Ліцензія даних — CC BY 4.0: у застосунку під поїздами стоїть
// підпис джерела. DB позначає API як тестове (BETA) і не гарантує
// точності, тож це підказка, а не заміна табло на вокзалі.
//
// ЧОМУ НЕ РАНІШЕ ЗА 18 ГОДИН
// DB віддає розклад станції лише приблизно на 18 годин наперед. Тому
// перевірка починається напередодні ввечері; поки зарано, поїзд має
// стан «later», і застосунок нічого біля нього не показує.
//
// ЯК ЗНАХОДИМО ПОЇЗД
//  1. Станцію відправлення шукаємо за назвою (/station). У великих
//     вокзалів кілька «підстанцій» зі своїми номерами — у München Hbf це
//     Gl.27-36, Gl.5-10 і S-Bahn (tief). Їх беремо всі, інакше поїзди
//     з бічних колій просто не знайшлися б.
//  2. Беремо розклад станції на годину відправлення (/plan) і шукаємо
//     відправлення рівно о вписаній хвилині. Якщо таких кілька — за
//     назвою поїзда («RB 6», «RE 4012», «S8») і за кінцевою станцією.
//  3. Зміни (/fchg): новий час, нова колія, скасування, скорочений
//     маршрут. Немає змін — поїзд за розкладом.
//  Поїзда о цій хвилині немає, але є о сусідній (до ±30 хв) з тією самою
//  назвою й у той самий бік — це стан «time»: зміна розкладу чи описка.
//  Немає взагалі — «notfound», але лише коли до відправлення менше
//  16 годин і розклад станції на ту годину не порожній. Між 16 і 18
//  годинами — «later» (DB ще міг не викласти розклад). Інакше —
//  «unknown» з причиною: краще промовчати, ніж налякати хибною тривогою.
//  4. Знайдений поїзд має за розкладом їхати до вписаної станції (інакше
//     «partial», «не доїде до …»), а на ній — прибувати о вписаній
//     хвилині (інакше «time» з новим часом прибуття). Прибуття шукаємо
//     на табло станції призначення за номером рейсу DB.
//  5. Пересадки: прибуття за DB пізніше за відправлення наступного
//     поїзда — рядок у transfers («пересадку не встигнути»).
//
// АДРЕСИ
//   GET /api/trains?trip=<номер>  — стан поїздів поїздки (для застосунку
//                                    й годинника сповіщень)
//   GET /api/trains               — перевірка налаштувань: чи вписані
//                                    ключі й чи DB їх приймає
//
// КЕШ
// Відповідь для поїздки кешується мережею Vercel на 2 хвилини: скільки б
// учасників не відкрили поїздку, до DB іде один запит на 2 хвилини.
// Годинник додає &fresh=… і отримує свіжі дані.
//
// ЗМІННІ СЕРЕДОВИЩА (Vercel → Settings → Environment Variables)
//   DB_CLIENT_ID       — Client ID застосунку з DB API Marketplace
//   DB_API_KEY         — Client Secret (API Key) того ж застосунку
//   SUPABASE_URL       — уже є
//   SUPABASE_ANON_KEY  — уже є (читає лише опубліковані поїздки)
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 30 };

const VERSION = "t2";
const BASE = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1";
const TZ = "Europe/Berlin";
const WINDOW_MIN = 18 * 60;          // DB дає розклад приблизно на 18 год наперед
const NOTFOUND_MAX_MIN = 16 * 60;    // «немає в розкладі» кажемо лише ближче за 16 год
const TOLERANCE_MIN = 2;             // сусідні хвилини: імовірна описка
const WIDE_MIN = 30;                 // той самий поїзд, зсунутий розкладом
const DELAY_SHOW_MIN = 2;            // запізнення від 2 хв уже показуємо
const PLAN_TTL_MS = 6 * 3600 * 1000; // розклад DB незмінний — пам'ятаємо довше
const PLAN_EMPTY_TTL_MS = 10 * 60 * 1000;
const REQ_TIMEOUT_MS = 6000;
const TRIP_BUDGET_MS = 18000;        // уся поїздка — не довше; решта поїздів стає «невідомо»
const PARALLEL = 4;
export const SOURCE = "Deutsche Bahn · Timetables API · CC BY 4.0";

// Запасний перелік «підстанцій» на випадок, якщо DB не віддасть їх сама.
const META = {
  "8000261": ["8098261", "8098262", "8098263"],   // München Hbf
};

// ── Кеш у пам'яті «теплої» функції ───────────────────────────────────
const memo = new Map();
const cget = (k) => {
  const v = memo.get(k);
  if (!v) return undefined;
  if (Date.now() > v.until) { memo.delete(k); return undefined; }
  return v.val;
};
const cset = (k, val, ttlMs) => {
  if (memo.size > 1500) memo.clear();
  memo.set(k, { val, until: Date.now() + ttlMs });
  return val;
};
// Для тестів: почати з чистої пам'яті.
export const _resetCache = () => memo.clear();
// Той самий запит, що вже в дорозі, не відправляємо вдруге: два поїзди з
// однієї станції чекають одну відповідь. Помилку не кешуємо. ttlFor —
// інший строк для окремих відповідей (порожній розклад — ненадовго).
function memoAsync(key, ttlMs, fn, ttlFor) {
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const p = Promise.resolve().then(fn);
  cset(key, p, ttlMs);
  p.then((v) => {
    const t = ttlFor ? ttlFor(v) : null;
    if (t != null) cset(key, Promise.resolve(v), t);
  }, () => { memo.delete(key); });
  return p;
}

// ── Розбір XML без бібліотек ─────────────────────────────────────────
// Відповіді DB прості: кілька видів тегів і атрибути. Окремий парсер
// означав би правку package.json, а зайва кома там ламає всю збірку.
const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  }
  return ENT[e.toLowerCase()];
});
function attrs(s) {
  const o = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s || ""))) o[m[1]] = decode(m[2] != null ? m[2] : m[3]);
  return o;
}
function firstTag(body, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${tag}>)`);
  const m = re.exec(body || "");
  return m ? attrs(m[1]) : null;
}
export function parseTimetable(xml) {
  const text = String(xml || "");
  const root = /<timetable\b([^>]*)>/.exec(text);
  const ra = root ? attrs(root[1]) : {};
  const stops = [];
  const re = /<s\b([^>]*?)(?:\/>|>([\s\S]*?)<\/s>)/g;
  let m;
  while ((m = re.exec(text))) {
    const a = attrs(m[1]);
    const body = m[2] || "";
    stops.push({
      id: a.id || "",
      eva: a.eva || ra.eva || "",
      tl: firstTag(body, "tl"),
      ar: firstTag(body, "ar"),
      dp: firstTag(body, "dp"),
    });
  }
  return { station: ra.station || "", eva: ra.eva || "", stops };
}
export function parseStations(xml) {
  const out = [];
  const re = /<station\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const a = attrs(m[1]);
    if (!a.eva) continue;
    out.push({
      name: a.name || "", eva: String(a.eva), ds100: a.ds100 || "",
      meta: String(a.meta || "").split("|").map((x) => x.trim()).filter(Boolean),
    });
  }
  return out;
}

// ── Порівняння назв ──────────────────────────────────────────────────
const str = (v) => (v == null ? "" : typeof v === "string" ? v : String(v.uk || v.en || v.ru || ""));
// «München Hbf» = «Muenchen Hauptbahnhof» = «munchen hbf»
export const normName = (s) => str(s).toLowerCase()
  .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
  .replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u")
  .replace(/hauptbahnhof/g, "hbf")
  .replace(/[^a-z0-9]/g, "");
// «RB 6» → «RB6»
export const normTrain = (s) => str(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const hhmmOf = (v) => {
  const m = str(v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
};
// Ключ поїзда — однаковий тут і в застосунку (App.jsx → trainLegKey).
export const legKey = (l) => `${normName(l && l.from)}|${hhmmOf(l && l.fromTime)}|${normTrain(l && l.train)}`;

// Назва поїзда від організатора: «RB 6», «RE 4012», «S8», «BRB RB55»,
// «Meridian RE5 (Salzburg)». Беремо всі пари «літери + число».
export function trainTokens(text) {
  const t = str(text).toUpperCase();
  const out = [];
  const re = /(?:^|[^A-Z0-9])([A-Z]{1,4})?\s*-?\s*(\d{1,5})(?![0-9])/g;
  let m;
  while ((m = re.exec(t))) out.push({ c: m[1] || "", n: m[2] });
  return out;
}
// Автобус, канатна дорога, корабель, метро — їх у табло DB немає. Такі
// відрізки не звіряємо взагалі: інакше «Bus 9608» щоразу виходив би
// «немає в розкладі», а «Wanderbus» без номера збігся б із першим-ліпшим
// поїздом тієї хвилини. З t2 — і будь-яке слово, що закінчується на
// «bus»: «Ersatzbus RB67» раніше звірявся як поїзд RB67.
const NON_RAIL = /(bus\b|\b(sev|schienenersatz\w*|ersatzverkehr|seilbahn|bergbahn|zahnradbahn|zugspitzbahn|wendelsteinbahn|gondel\w*|sessellift|lift|schiff|boot|fähre|faehre|ferry|tram|straßenbahn|strassenbahn|u-?bahn|metro|taxi)\b)/i;
const NON_RAIL_UK = /(автобус|бус\b|канатн|фунікулер|підйомник|паром|теплохід|корабель|трамвай|метро|таксі)/i;
export function isNonRail(text) {
  const t = str(text);
  if (NON_RAIL.test(t) || NON_RAIL_UK.test(t)) return true;
  // «U3», «U 6» — метро; «Tram 19».
  return trainTokens(t).some((k) => k.c === "U" || k.c === "STR");
}
// Наскільки поїзд DB схожий на вписаний: 2 — точно той, 1 — схожий
// (номер той, категорія інша), 0 — інший. Без назви у вписаному — 1.
export function trainScore(tokens, st) {
  if (!tokens.length) return 1;
  const tl = (st && st.tl) || {};
  const ev = (st && (st.dp || st.ar)) || {};
  const c = normTrain(tl.c), n = normTrain(tl.n);
  const line = normTrain(ev.l || tl.l);
  const labels = new Set([c + n, n]);
  if (line) {
    labels.add(line);
    if (/^\d+$/.test(line)) labels.add(c + line);
  }
  let best = 0;
  for (const k of tokens) {
    const label = k.c + k.n;
    if (k.c && labels.has(label)) return 2;
    if (k.n === n) return 2;
    if (/^\d+$/.test(line) && k.n === line) best = Math.max(best, k.c && k.c !== c ? 1 : 2);
    if (!k.c && labels.has(k.n)) best = Math.max(best, 2);
  }
  return best;
}
const splitPath = (p) => str(p).split("|").map((x) => x.trim()).filter(Boolean);

// Наскільки вписана назва станції схожа на назву в DB:
//   3 — та сама («Landsberg am Lech» = «Landsberg(Lech)»);
//   2 — та сама без уточнення в дужках («Weilheim» = «Weilheim(Oberbay)»,
//       «Kempten Hbf» = «Kempten(Allgäu)Hbf»);
//   1 — схожа: одна назва — початок іншої («Garmisch» →
//       «Garmisch-Partenkirchen») або її частина («Hochzoll»);
//   0 — інша.
// Службові слова («am», «an der», «im», «bei», «Bahnhof») не важать.
const STATION_STOP = new Set(["am", "an", "der", "die", "das", "im", "in", "bei", "ob", "bahnhof", "bf"]);
const deWords = (s) => str(s).toLowerCase()
  .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
  .replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u")
  .replace(/hauptbahnhof/g, "hbf")
  .split(/[^a-z0-9]+/).filter(Boolean);
const looseKey = (s) => deWords(s).filter((w) => !STATION_STOP.has(w)).join("");
const baseKey = (s) => looseKey(str(s).replace(/\([^)]*\)/g, " "));
export function stationTier(typed, dbName) {
  const a = normName(typed), b = normName(dbName);
  if (!a || !b) return 0;
  if (a === b) return 3;
  const la = looseKey(typed), lb = looseKey(dbName);
  if (la && la === lb) return 3;
  const ba = baseKey(typed), bb = baseKey(dbName);
  if (ba && ba === bb) return 2;
  const short = Math.min(la.length, lb.length);
  if (short >= 5 && (lb.startsWith(la) || la.startsWith(lb))) return 1;
  if (la.length >= 5 && lb.includes(la)) return 1;
  return 0;
}
// Чи є станція в маршруті поїзда. Організатор може писати коротше
// («Garmisch» замість «Garmisch-Partenkirchen»).
export function pathHas(path, name) {
  if (!normName(name)) return false;
  return splitPath(path).some((s) => stationTier(name, s) >= 1);
}
// Колія: «27» = «Gl. 27» = «Gleis 27» = «колія 27»; «5» ≈ «5a». Беремо
// перше число з літерою після нього, слова довкола не важать.
const normPlatform = (p) => {
  const t = str(p).toUpperCase();
  const m = t.match(/\d+[A-Z]?/);
  return m ? m[0] : t.replace(/[^0-9A-Z]/g, "");
};
export function samePlatform(a, b) {
  const x = normPlatform(a), y = normPlatform(b);
  if (!x || !y) return true;
  if (x === y) return true;
  const dx = (x.match(/^\d+/) || [""])[0], dy = (y.match(/^\d+/) || [""])[0];
  return dx !== "" && dx === dy;
}

// ── Час ──────────────────────────────────────────────────────────────
function berlinNow(d) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = {};
  f.formatToParts(d || new Date()).forEach((x) => { p[x.type] = x.value; });
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, min: hour * 60 + Number(p.minute) };
}
// Хвилини від «2026-10-03 08:32» до «2026-10-03 07:10» тощо — без поясів,
// бо обидва часи берлінські.
const absMin = (iso, hhmm) => {
  const d = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = String(hhmm).match(/(\d{1,2}):(\d{2})/);
  if (!d || !t) return null;
  return Date.UTC(+d[1], d[2] - 1, +d[3], +t[1], +t[2]) / 60000;
};
// «2610030832» — так DB пише час.
const dbTs = (iso, hhmm) => {
  const d = String(iso).match(/^\d{2}(\d{2})-(\d{2})-(\d{2})/);
  const t = hhmmOf(hhmm);
  return d && t ? `${d[1]}${d[2]}${d[3]}${t.replace(":", "")}` : "";
};
const tsMin = (ts) => {
  const m = String(ts || "").match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? Date.UTC(2000 + +m[1], m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
};
const tsHHMM = (ts) => {
  const m = String(ts || "").match(/^\d{6}(\d{2})(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
};
const stopLabel = (st) => {
  const tl = st.tl || {}, ev = st.dp || st.ar || {};
  const line = String(ev.l || tl.l || "");
  if (line && /^\d+$/.test(line)) return `${tl.c || ""} ${line}`.trim();
  if (line) return line;
  return `${tl.c || ""} ${tl.n || ""}`.trim();
};

// ── Запити до DB ─────────────────────────────────────────────────────
class DbError extends Error {
  constructor(code, status, msg) { super(msg || code); this.code = code; this.status = status; }
}
export function makeDb(creds, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  let calls = 0;
  async function get(path) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
    calls++;
    try {
      let r;
      try {
        r = await doFetch(BASE + path, {
          headers: { "DB-Client-Id": creds.id, "DB-Api-Key": creds.key, Accept: "application/xml" },
          signal: ctl.signal,
        });
      } catch (e) {
        throw new DbError("network", 0, String((e && e.message) || e));
      }
      if (r.status === 401 || r.status === 403) throw new DbError("auth", r.status);
      if (r.status === 429) throw new DbError("rate", 429);
      // Порожня година чи невідома станція — це «нема даних», а не збій.
      if (r.status === 404 || r.status === 410) return "";
      if (!r.ok) throw new DbError("http", r.status);
      return await r.text();
    } finally {
      clearTimeout(timer);
    }
  }
  return { get, calls: () => calls };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// Пошук станції в DB іде за ПОЧАТКОМ назви: «Landsberg am Lech» DB не
// знаходить, бо в нього вона «Landsberg(Lech)». Тож пробуємо кілька
// написань — як є, без дужок, «X am Y» → «X(Y)», перше слово — і з усіх
// знайдених беремо найсхожішу (stationTier).
export function stationQueries(name) {
  const raw = str(name).replace(/\s+/g, " ").trim();
  const out = [];
  const add = (s) => {
    const v = String(s || "").replace(/\s+/g, " ").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  add(raw);
  add(raw.replace(/\([^)]*\)/g, " "));
  const m = raw.match(/^(.+?)\s+(?:am|an der|an|im|in der|in|bei|ob der)\s+(.+)$/i);
  if (m) { add(`${m[1]}(${m[2]})`); add(`${m[1]} (${m[2]})`); }
  add(raw.split(/[\s(,/]+/)[0]);
  return out;
}
// Код станції DB (DS100) у Баварії починається з M (München) чи N
// (Nürnberg). Серед однойменних станцій беремо баварську: поїздки клубу
// стартують у Баварії.
const isBavarian = (s) => /^[MN]/i.test(String((s && s.ds100) || ""));
export function pickStation(name, candidates) {
  let tier = 0, best = [];
  for (const s of candidates) {
    const t = stationTier(name, s.name);
    if (t === 0) continue;
    if (t > tier) { tier = t; best = [s]; }
    else if (t === tier && !best.some((b) => b.eva === s.eva)) best.push(s);
  }
  if (tier === 0) return null;
  let chosen = best[0], ambiguous = false;
  if (best.length > 1) {
    const bav = best.filter(isBavarian);
    if (bav.length === 1) chosen = bav[0];
    else { chosen = (bav[0] || best[0]); ambiguous = true; }
  }
  return { station: chosen, tier, ambiguous };
}
function resolveStation(db, name) {
  return memoAsync(`st:${normName(name)}`, 12 * 3600 * 1000, async () => {
    const seen = new Map();
    let pick = null;
    for (const q of stationQueries(name)) {
      const list = parseStations(await db.get(`/station/${encodeURIComponent(q)}`));
      list.forEach((s) => { if (!seen.has(s.eva)) seen.set(s.eva, s); });
      pick = pickStation(name, [...seen.values()]);
      if (pick && pick.tier === 3 && !pick.ambiguous) break;
    }
    if (!pick) return null;
    const best = pick.station;
    const evas = [...new Set([best.eva, ...best.meta, ...(META[best.eva] || [])])];
    // fallback — назва збіглась лише приблизно або однойменних кілька.
    // Тоді «немає в розкладі» не кажемо: це могла бути інша станція.
    return { name: best.name, eva: best.eva, evas, fallback: pick.tier < 2 || pick.ambiguous };
  }, (v) => (v == null ? 30 * 60 * 1000 : null));
}
// Розклад DB на годину. Він незмінний («planned data … is static»), тож
// пам'ятаємо його 6 годин; порожню годину — 10 хвилин: DB міг ще не
// викласти розклад так далеко наперед.
function planSlice(db, eva, yymmdd, hh) {
  return memoAsync(`pl:${eva}:${yymmdd}:${hh}`, PLAN_TTL_MS, async () => {
    const tt = parseTimetable(await db.get(`/plan/${eva}/${yymmdd}/${hh}`));
    tt.stops.forEach((s) => { if (!s.eva) s.eva = eva; });
    return tt.stops;
  }, (v) => (Array.isArray(v) && v.length === 0 ? PLAN_EMPTY_TTL_MS : null));
}
function changesOf(db, eva) {
  return memoAsync(`ch:${eva}`, 45 * 1000, async () => {
    const map = {};
    parseTimetable(await db.get(`/fchg/${eva}`)).stops.forEach((s) => { if (s.id) map[s.id] = s; });
    return map;
  });
}

// ── Поїзди поїздки ───────────────────────────────────────────────────
const journeysOf = (trip) => {
  const t = trip || {};
  return Array.isArray(t.journeys) && t.journeys.length > 0
    ? t.journeys : (Array.isArray(t.legs) && t.legs.length > 0 ? [{ legs: t.legs }] : []);
};
const legUsable = (l) => Boolean(l) && str(l.from).trim() !== "" && hhmmOf(l.fromTime) !== "";
export function tripLegs(trip) {
  const out = [];
  const seen = new Set();
  for (const j of journeysOf(trip)) {
    for (const l of ((j && j.legs) || [])) {
      if (!legUsable(l)) continue;
      const key = legKey(l);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key, from: str(l.from).trim(), time: hhmmOf(l.fromTime), train: str(l.train).trim(),
        to: str(l.to).trim(), toTime: hhmmOf(l.toTime), platform: str(l.platform).trim(),
      });
    }
  }
  return out;
}

// Найсуворіший стан — для підсумку й кольору в застосунку.
const RANK = ["ok", "time", "platform", "delay", "notfound", "partial", "cancelled"];
const worst = (a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a);

// Номер рейсу DB з ідентифікатора зупинки «<рейс>-<дата>-<номер зупинки>».
// На всіх станціях рейсу перші дві частини однакові — за ними знаходимо
// той самий поїзд на станції прибуття.
export const tripIdOf = (id) => {
  const m = String(id || "").match(/^(-?\d+-\d{6,10})-\d+$/);
  return m ? m[1] : "";
};
// Година розкладу DB для «берлінської хвилини» (див. absMin).
const hourOf = (abs) => {
  const iso = new Date(abs * 60000).toISOString();
  return { ymd: iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10), h: iso.slice(11, 13), mm: Number(iso.slice(14, 16)) };
};
const stampOf = (abs) => {
  const iso = new Date(abs * 60000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};
// Розклад години містить поїзди, що в цю годину прибувають АБО
// відправляються. Тож поїзд «прибуває 08:58, відправляється 09:00» є і
// в годині 08, і в 09. Без цього він рахувався б двічі й «зрівнявся» сам
// із собою.
const dedupeStops = (lists) => {
  const seen = new Set();
  return lists.flat().filter((s) => {
    if (!s) return false;
    const k = `${s.eva}|${s.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
async function slicesAt(db, evas, hours) {
  const lists = await mapLimit(
    evas.flatMap((eva) => hours.map((s) => ({ eva, s }))),
    PARALLEL,
    ({ eva, s }) => planSlice(db, eva, s.ymd, s.h),
  );
  return dedupeStops(lists);
}
// Прибуття ТОГО САМОГО рейсу на станцію призначення — за розкладом DB.
// Шукаємо в годині вписаного прибуття й у сусідній.
async function arrivalOf(db, trip, leg, match, depAbs) {
  const tid = tripIdOf(match.id);
  if (!tid || !leg.to || !leg.toTime) return null;
  let arrAbs = absMin(trip.date, leg.toTime);
  if (arrAbs == null) return null;
  if (arrAbs < depAbs) arrAbs += 24 * 60;          // прибуття після півночі
  const dest = await resolveStation(db, leg.to);
  if (!dest) return null;
  const h0 = hourOf(arrAbs);
  for (const k of [0, h0.mm >= 30 ? 1 : -1]) {
    const at = arrAbs + k * 60;
    if (at < depAbs - 60) continue;
    const stops = await slicesAt(db, dest.evas, [hourOf(at)]);
    const s = stops.find((x) => x.ar && x.ar.pt && tripIdOf(x.id) === tid);
    if (s) return { hhmm: tsHHMM(s.ar.pt), abs: tsMin(s.ar.pt) };
  }
  return null;
}

// Стан одного поїзда. now — { date, min } берлінський.
export async function checkLeg(db, trip, leg, now) {
  const base = { key: leg.key, from: leg.from, time: leg.time, train: leg.train, to: leg.to };
  if (isNonRail(leg.train)) return { ...base, state: "nonrail" };
  const dep = absMin(trip.date, leg.time);
  const nowAbs = absMin(now.date, `${Math.floor(now.min / 60)}:${String(now.min % 60).padStart(2, "0")}`);
  if (dep == null || nowAbs == null) return { ...base, state: "unknown", why: "немає дати чи часу відправлення" };
  const until = dep - nowAbs;
  if (until > WINDOW_MIN) return { ...base, state: "later", checkFrom: stampOf(dep - WINDOW_MIN) };
  // Поїзд, що запізнюється, ще стоїть на табло після часу за розкладом —
  // тому дивимось і впродовж 90 хвилин після нього. Без змін там — він
  // уже поїхав.
  if (until < -90) return { ...base, state: "departed" };
  const afterPlan = until < -1;

  const station = await resolveStation(db, leg.from);
  if (!station) return { ...base, state: "unknown", why: `станцію «${leg.from}» не знайдено в DB` };

  const target = dbTs(trip.date, leg.time);
  const targetMin = tsMin(target);
  const h0 = hourOf(dep);
  // Сусідня година потрібна лише для пошуку «±2 хв» на межі години.
  const hours = [h0];
  if (h0.mm >= 60 - TOLERANCE_MIN) hours.push(hourOf(dep + 60));
  if (h0.mm < TOLERANCE_MIN) hours.push(hourOf(dep - 60));
  const stops = (await slicesAt(db, station.evas, hours)).filter((s) => s.dp && s.dp.pt);
  const tokens = trainTokens(leg.train);

  const rank = (st) => trainScore(tokens, st) * 10 + (pathHas(st.dp.ppth, leg.to) ? 2 : 0)
    + (leg.platform && samePlatform(leg.platform, st.dp.pp) ? 1 : 0);
  const pickBest = (cands) => {
    const scored = cands.map((st) => ({ st, r: rank(st) })).sort((a, b) => b.r - a.r);
    if (scored.length === 0) return null;
    if (scored.length > 1 && scored[0].r === scored[1].r) return "tie";
    return scored[0].st;
  };

  let exact = stops.filter((st) => st.dp.pt === target);
  if (tokens.length) exact = exact.filter((st) => trainScore(tokens, st) > 0);
  // Назва без номера («Werdenfelsbahn», «BRB» чи порожньо): віримо збігу
  // лише тоді, коли поїзд справді їде до вписаної кінцевої.
  else exact = exact.filter((st) => pathHas(st.dp.ppth, leg.to));
  let match = pickBest(exact);
  let timeShift = false;
  // Та сама назва поїзда за дві хвилини до чи після — імовірна описка в
  // часі. Без назви поїзда так не вгадуємо.
  if (!match && tokens.length) {
    const near = stops.filter((st) => {
      const d = tsMin(st.dp.pt) - targetMin;
      return d !== 0 && Math.abs(d) <= TOLERANCE_MIN && trainScore(tokens, st) === 2;
    });
    const m2 = pickBest(near);
    if (m2 === "tie") match = "tie";
    else if (m2) { match = m2; timeShift = true; }
  }
  // Та сама назва і той самий напрямок до ±30 хв — розклад зсунули
  // (будівельні роботи, новий розклад). Краще сказати новий час, ніж
  // «немає в розкладі».
  if (!match && tokens.length && leg.to) {
    const more = (await slicesAt(db, station.evas, [hourOf(dep + (h0.mm < 30 ? -60 : 60))]))
      .filter((s) => s.dp && s.dp.pt);
    const wide = dedupeStops([stops, more])
      .map((st) => ({ st, d: Math.abs(tsMin(st.dp.pt) - targetMin) }))
      .filter(({ st, d }) => d > TOLERANCE_MIN && d <= WIDE_MIN
        && trainScore(tokens, st) === 2 && pathHas(st.dp.ppth, leg.to))
      .sort((a, b) => a.d - b.d);
    if (wide.length > 1 && wide[0].d === wide[1].d) match = "tie";
    else if (wide.length) { match = wide[0].st; timeShift = true; }
  }
  if (match === "tie") return { ...base, state: "unknown", why: "кілька схожих поїздів поруч — уточни назву поїзда" };
  if (!match) {
    if (afterPlan) return { ...base, state: "departed" };
    // Далі ніж 16 год DB міг ще не викласти розклад повністю — чекаємо.
    if (until > NOTFOUND_MAX_MIN) return { ...base, state: "later", checkFrom: stampOf(dep - NOTFOUND_MAX_MIN) };
    if (stops.length === 0) return { ...base, state: "unknown", why: `DB не дав розкладу станції ${station.name} на цю годину` };
    // «Немає в розкладі» — лише для поїзда з назвою й номером на станції,
    // яку DB знайшов однозначно. Інакше це могла бути інша станція чи не
    // поїзд DB, і тривога вийшла б хибною.
    if (tokens.length === 0) return { ...base, state: "unknown", why: "без номера поїзда й без збігу кінцевої" };
    if (station.fallback) return { ...base, state: "unknown", why: `станцію знайдено неточно: ${station.name}` };
    return { ...base, state: "notfound" };
  }

  const ch = (await changesOf(db, match.eva))[match.id] || null;
  const cdp = (ch && ch.dp) || {};
  if (afterPlan) {
    // Після часу за розкладом показуємо лише те, що ще попереду:
    // запізнення з новим часом у майбутньому чи скасування.
    const ctMin = cdp.ct ? tsMin(cdp.ct) : null;
    if (!(cdp.cs === "c" || (ctMin != null && ctMin >= nowAbs))) return { ...base, state: "departed" };
  }
  // dbTrip — номер рейсу DB: той самий поїзд у різних картках поїздки
  // (з Augsburg, з Geltendorf) сповіщення згадає раз.
  const out = { ...base, state: "ok", dbLabel: stopLabel(match), dbTime: tsHHMM(match.dp.pt), dbTrip: tripIdOf(match.id) };
  let state = "ok";
  if (timeShift) {
    out.depNow = out.dbTime;
    state = worst(state, "time");
  }
  if (cdp.cs === "c" || match.dp.cs === "c") {
    out.cancelled = true;
    state = worst(state, "cancelled");
  }
  // За розкладом поїзд не їде до вписаної станції: рейс укорочено, або о
  // цій хвилині їде зовсім інший поїзд (скажімо, у протилежний бік).
  const plannedPath = match.dp.ppth;
  if (!out.cancelled && leg.to && plannedPath && !pathHas(plannedPath, leg.to)) {
    out.partialTo = leg.to;
    out.partialPlanned = true;
    state = worst(state, "partial");
  }
  // Сьогоднішня зміна маршруту (скорочений рейс).
  if (!out.cancelled && !out.partialTo && cdp.cpth != null && pathHas(plannedPath, leg.to) && !pathHas(cdp.cpth, leg.to)) {
    out.partialTo = leg.to;
    state = worst(state, "partial");
  }
  // Прибуття за розкладом DB. Помилка тут не псує решту: просто без
  // звірки прибуття.
  if (!out.cancelled && !out.partialTo && leg.toTime) {
    let arr = null;
    try { arr = await arrivalOf(db, trip, leg, match, dep); }
    catch (e) { if (e && e.code === "auth") throw e; }
    if (arr) {
      out.dbArr = arr.hhmm;
      let typed = absMin(trip.date, leg.toTime);
      if (typed != null && typed < dep) typed += 24 * 60;
      if (typed != null && Math.abs(arr.abs - typed) >= DELAY_SHOW_MIN) {
        out.arrNow = arr.hhmm;
        out.arrTyped = leg.toTime;
        state = worst(state, "time");
      }
    }
  }
  if (cdp.ct) {
    const delay = tsMin(cdp.ct) - tsMin(match.dp.pt);
    if (delay >= DELAY_SHOW_MIN) {
      out.delay = delay;
      out.newTime = tsHHMM(cdp.ct);
      state = worst(state, "delay");
    }
  }
  const planned = match.dp.pp || "";
  if (cdp.cp && !samePlatform(cdp.cp, planned)) {
    out.platformNow = cdp.cp;
    out.platformWas = planned;
    state = worst(state, "platform");
  } else if (leg.platform && planned && !samePlatform(leg.platform, planned)) {
    out.platformNow = planned;
    out.platformTyped = leg.platform;
    state = worst(state, "platform");
  } else if (planned) {
    out.platform = cdp.cp || planned;
  }
  out.state = state;
  return out;
}

// Пересадки, на які за розкладом DB уже не встигнути: поїзд прибуває
// пізніше, ніж відправляється наступний. Лише коли щось змінив саме DB —
// описки в самій поїздці тут не шукаємо.
export function tripTransfers(trip, byKey) {
  const out = [];
  const seen = new Set();
  const minOf = (v) => {
    const m = String(v || "").match(/^(\d{2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const gone = (r) => ["cancelled", "notfound", "partial"].includes(r && r.state);
  for (const j of journeysOf(trip)) {
    const ls = ((j && j.legs) || []).filter(legUsable);
    for (let i = 0; i + 1 < ls.length; i++) {
      const a = ls[i], b = ls[i + 1];
      const ka = legKey(a), kb = legKey(b), key = `${ka}>${kb}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ra = byKey[ka] || {}, rb = byKey[kb] || {};
      if (gone(ra) || gone(rb)) continue;
      const typedArr = hhmmOf(a.toTime), typedDep = hhmmOf(b.fromTime);
      const arr = ra.dbArr || typedArr;
      const dep = rb.dbTime || typedDep;
      const changed = Boolean((ra.dbArr && ra.dbArr !== typedArr) || (rb.dbTime && rb.dbTime !== typedDep));
      const x = minOf(arr), y = minOf(dep);
      if (!changed || x == null || y == null) continue;
      if (x > y && x - y < 12 * 60) out.push({ key, a: ka, b: kb, at: str(b.from).trim(), arr, dep });
    }
  }
  return out;
}

// Стан усіх поїздів поїздки.
export async function checkTrip(db, trip, nowDate) {
  const now = berlinNow(nowDate);
  const legs = tripLegs(trip);
  const status = String((trip && trip.status) || "");
  if (status === "cancelled") return { legs: [], transfers: [], note: "поїздку скасовано" };
  // Перенесена поїздка зберігає стару дату, нова — лише текстом. Звіряти
  // поїзди старого дня немає сенсу.
  if (status === "postponed") return { legs: [], transfers: [], note: "поїздку перенесено" };
  const started = Date.now();
  const results = await mapLimit(legs, 2, async (leg) => {
    const left = TRIP_BUDGET_MS - (Date.now() - started);
    try {
      if (left <= 0) throw new DbError("budget", 0);
      let timer;
      const out = await Promise.race([
        checkLeg(db, trip, leg, now),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new DbError("budget", 0)), left); }),
      ]);
      clearTimeout(timer);
      return out;
    } catch (e) {
      if (e && e.code === "auth") throw e;
      const code = String((e && e.code) || (e && e.message) || e).slice(0, 80);
      const why = code === "budget" ? "DB відповідав задовго — спробую ще раз"
        : code === "rate" ? "забагато запитів до DB — спробую ще раз"
          : `помилка DB: ${code}`;
      return { key: leg.key, from: leg.from, time: leg.time, train: leg.train, to: leg.to, state: "unknown", why };
    }
  });
  const byKey = {};
  results.forEach((r) => { if (r && r.key) byKey[r.key] = r; });
  const hm = `${String(Math.floor(now.min / 60)).padStart(2, "0")}:${String(now.min % 60).padStart(2, "0")}`;
  return { legs: results, transfers: tripTransfers(trip, byKey), checkedAt: hm, checkedDate: now.date };
}

// ── Сам обробник ─────────────────────────────────────────────────────
const creds = () => ({ id: process.env.DB_CLIENT_ID || "", key: process.env.DB_API_KEY || "" });

async function loadTrip(id) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/trips?id=eq.${encodeURIComponent(id)}&select=data`;
  const r = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` },
  });
  if (!r.ok) throw new Error(`trip ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") { res.status(405).json({ error: "лише GET" }); return; }
  const c = creds();
  const configured = Boolean(c.id && c.key);
  const q = req.query || {};
  const tripId = String(q.trip || "").slice(0, 100);

  // ── Перевірка налаштувань: <сайт>/api/trains ──────────────────────
  if (!tripId) {
    const report = {
      "версія": VERSION,
      "налаштовано": configured,
      "бракує змінних": ["DB_CLIENT_ID", "DB_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY"].filter((k) => !process.env[k]),
      "джерело": SOURCE,
    };
    if (configured) {
      try {
        // Перевірку кешуємо на хвилину: часте оновлення сторінки не
        // повинно з'їдати ліміт DB (60 запитів на хвилину).
        const st = await memoAsync("health", 60 * 1000, async () =>
          parseStations(await makeDb(c).get(`/station/${encodeURIComponent("München Hbf")}`)));
        report["DB"] = st.length
          ? `відповідає · München Hbf = ${st[0].eva}${st[0].meta.length ? ` (+${st[0].meta.length} пов'язані)` : ""}`
          : "відповідає, але станцію не знайдено";
      } catch (e) {
        report["DB"] = e && e.code === "auth"
          ? `не приймає ключі (помилка ${e.status}): перевір DB_CLIENT_ID, DB_API_KEY і підписку на Timetables`
          : `не відповідає: ${String((e && (e.code || e.message)) || e).slice(0, 120)}`;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(report);
    return;
  }

  const fresh = Boolean(q.fresh);
  res.setHeader("Cache-Control", fresh ? "no-store" : "public, max-age=0, s-maxage=120, stale-while-revalidate=300");
  if (!configured) {
    res.status(200).json({ version: VERSION, configured: false, legs: [] });
    return;
  }
  let trip;
  try { trip = await loadTrip(tripId); }
  catch (e) { res.status(200).json({ version: VERSION, configured: true, legs: [], error: "trip" }); return; }
  if (!trip) {
    res.status(200).json({ version: VERSION, configured: true, legs: [], note: "поїздки немає або вона в розробці" });
    return;
  }
  const db = makeDb(c);
  try {
    const r = await checkTrip(db, trip);
    res.status(200).json({ version: VERSION, configured: true, auth: true, trip: tripId, date: trip.date || "", source: SOURCE, calls: db.calls(), ...r });
  } catch (e) {
    if (e && e.code === "auth") {
      res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60");
      res.status(200).json({ version: VERSION, configured: true, auth: false, legs: [], error: `auth ${e.status}` });
      return;
    }
    res.status(200).json({ version: VERSION, configured: true, legs: [], error: String((e && (e.code || e.message)) || e).slice(0, 120) });
  }
}
