// ═══ Tropa Club · api/trains.js · ВЕРСІЯ t3 ═══
// t3 — станції знаходяться за власним переліком станцій табло DB (IRIS):
//      пошук DB за назвою «München-Pasing» не знаходив ні так, ні як
//      «München Pasing», тож поїзди звідти лишались незвіреними. Тепер
//      назва звіряється з переліком (Баварія, Баден-Вюртемберг, Австрія),
//      а DB питаємо вже номер станції — його він знаходить завжди. Пошук
//      за назвою лишився запасним — для станцій поза переліком.
//      • Зчеплений поїзд («RB6/RB60»): DB показує дві частини одного
//        складу — з тієї самої колії в ту саму хвилину. Це один поїзд,
//        а не «кілька схожих».
//      • Перевірка однієї назви: <сайт>/api/trains?station=München-Pasing
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

const VERSION = "t3";
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
const stationKeys = (s) => ({ n: normName(s), l: looseKey(s), b: baseKey(s) });
function tierOfKeys(A, B) {
  if (!A.n || !B.n) return 0;
  if (A.n === B.n) return 3;
  if (A.l && A.l === B.l) return 3;
  if (A.b && A.b === B.b) return 2;
  const short = Math.min(A.l.length, B.l.length);
  if (short >= 5 && (B.l.startsWith(A.l) || A.l.startsWith(B.l))) return 1;
  if (A.l.length >= 5 && B.l.includes(A.l)) return 1;
  return 0;
}
export function stationTier(typed, dbName) {
  return tierOfKeys(stationKeys(typed), stationKeys(dbName));
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
  const want = stationKeys(name);
  for (const s of candidates) {
    const t = tierOfKeys(want, s.k || stationKeys(s.name));
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
// Станція з власного переліку (див. STATIONS_IRIS у кінці файлу). Номер
// станції DB знаходить завжди; заодно віддає «підстанції» великого
// вокзалу (meta) — без них поїзди з бічних колій не знаходились би.
async function fromIndex(db, name) {
  const local = pickStation(name, stationIndex());
  if (!local || local.tier < 2) return null;
  const best = local.station;
  let meta = [];
  try {
    const me = parseStations(await db.get(`/station/${best.eva}`)).find((x) => x.eva === best.eva);
    if (me) meta = me.meta;
  } catch (e) {
    if (e && e.code === "auth") throw e;   // без підстанцій — теж можна звіряти
  }
  const evas = [...new Set([best.eva, ...meta, ...(META[best.eva] || [])])];
  return { name: best.name, eva: best.eva, evas, fallback: local.ambiguous, source: "index" };
}
function resolveStation(db, name) {
  return memoAsync(`st:${normName(name)}`, 12 * 3600 * 1000, async () => {
    const own = await fromIndex(db, name);
    if (own) return own;
    // Станції немає в переліку (чи назва схожа лише приблизно) — шукаємо
    // за назвою в самому DB.
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
    return { name: best.name, eva: best.eva, evas, fallback: pick.tier < 2 || pick.ambiguous, source: "search" };
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
  // Зчеплений поїзд («RB6/RB60»): DB показує дві частини одного складу —
  // з тієї самої колії в ту саму хвилину. Для нас це один поїзд.
  const coupled = (list) => list.length > 1 && list.every((x) => x.dp.pt === list[0].dp.pt
    && String(x.dp.pp || "") !== "" && String(x.dp.pp) === String(list[0].dp.pp));
  const pickBest = (cands) => {
    const scored = cands.map((st) => ({ st, r: rank(st) })).sort((a, b) => b.r - a.r);
    if (scored.length === 0) return null;
    if (scored.length > 1 && scored[0].r === scored[1].r) {
      const top = scored.filter((x) => x.r === scored[0].r).map((x) => x.st);
      return coupled(top) ? top[0] : "tie";
    }
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
    const near0 = wide.filter((x) => wide.length && x.d === wide[0].d).map((x) => x.st);
    if (near0.length > 1 && !coupled(near0)) match = "tie";
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

  // ── Перевірка однієї назви станції: <сайт>/api/trains?station=… ────
  // Показує, яку станцію DB знайдено за назвою з поїздки і звідки.
  const stationQ = String(q.station || "").slice(0, 80).trim();
  if (stationQ && !tripId) {
    res.setHeader("Cache-Control", "no-store");
    const local = pickStation(stationQ, stationIndex());
    const out = {
      "версія": VERSION,
      "назва": stationQ,
      "у переліку": local ? { name: local.station.name, eva: local.station.eva, ds100: local.station.ds100, "схожість": local.tier, "кілька однойменних": local.ambiguous } : null,
    };
    if (configured) {
      try {
        const r = await resolveStation(makeDb(c), stationQ);
        out["DB"] = r ? { name: r.name, eva: r.eva, "номери": r.evas, "неточно": r.fallback, "звідки": r.source === "index" ? "перелік" : "пошук DB" } : "не знайдено";
      } catch (e) {
        out["DB"] = `помилка: ${String((e && (e.code || e.message)) || e).slice(0, 80)}`;
      }
    }
    res.status(200).json(out);
    return;
  }

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

// ── Перелік станцій табло DB (IRIS) ─────────────────────────────────
// Баварія (коди DS100 на M і N), Баден-Вюртемберг (T, R) і Австрія:
// назва | номер станції (EVA) | код DS100. Відкриті дані Deutsche Bahn,
// зібрані проєктом Travel-Status-DE-IRIS (github.com/derf/
// Travel-Status-DE-IRIS, share/stations.json), — там лише станції, які
// знає саме табло DB. Нова станція поза переліком однаково знайдеться
// пошуком DB за назвою (запасний шлях у resolveStation).
let STATION_LIST = null;
export function stationIndex() {
  if (STATION_LIST) return STATION_LIST;
  STATION_LIST = STATIONS_IRIS.split("\n").map((line) => {
    const [name, eva, ds100] = line.split("|");
    return { name, eva, ds100: (ds100 || "").trim(), meta: [], k: stationKeys(name) };
  }).filter((x) => x.name && x.eva);
  return STATION_LIST;
}
const STATIONS_IRIS = `Aalen Hbf|8000002|TA
Abensberg|8000410|MABG
Abfaltersbach/Drau Bahnhst|8100204|OAAB
Abschlag|8100627|OAASG
Absdorf-Hippersdorf|8100202|OAADH
Achenlohe|8100602|XAAC
Achern|8000412|RAH
Achern Stadt|8007001|RAHS
Achkarren|8007291|RAK
Adelschlag|8000419|MAD
Adelsdorf(Mittelfr)|8000420|NADM
Adelsheim Nord|8000423|RADN
Adelsheim Ost|8000424|TAD
Affaltrach|8000431|TAF
Agatharied|8000433|MAGD
Aglasterhausen|8007445|RAG
Aha|8000436|RA
Aich(Niederbay)|8000451|MAIC
Aich-Assach|8100597|OAAAS
Aichach|8000452|MAI
Aichstetten|8000454|TAI
Aindorf|8072132|MAID
Ainring|8000459|MAIN
Albbruck|8000463|RAL
Albersweiler(Pfalz)|8000466|RAR
Albsheim(Eis)|8070096|RAM
Albstadt-Ebingen|8000473|TAE
Albstadt-Ebingen West|8079089|TAEW
Albstadt-Laufen Ort|8000474|TALO
Albstadt-Lautlingen|8000475|TALT
Aldingen(b Spaichingen)|8000481|TALD
Aletshausen|8000482|MALH
Allensbach|8000496|RAB
Allentsteig|8100210|OAALL
Allerheiligenhöfe|8100548|XAAH
Allersberg(Rothsee)|8000498|NALB
Allmendingen|8000499|TALL
Alpirsbach|8000501|RALP
Altach|8100630|OAATA
Altbach|8000508|TACH
Altdorf West|8000504|NADW
Altdorf(b Nürnberg)|8000509|NAD
Altdorf(Niederbay)|8026354|MAF
Alte Veste|8000511|NAVE
Altenau(Bay)|8000515|MALT
Altenerding|8000524|MANE
Altenmarkt im Pongau|8100139|XAAL
Altenmarkt(Alz)|8000533|MATM
Altenstadt(Iller)|8000539|MASI
Altenstadt(Waldnaab)|8000540|NALW
Altglashütten-Falkau|8000544|RAT
Althegnenberg|8000545|MAHB
Altingen(Württ)|8070591|TAG
Altnagelberg|8169949|PAYOR
Altomünster|8000556|MAMT
Altshausen|8000559|TAT
Altstädten(Allgäu)|8000561|MATS
Alttann|8000562|TATN
Altweitra|8100643|OAAW
Altötting|8000555|MAT
Amberg|8000566|NAM
Amerang|8070802|MAMG
Amorbach|8000575|NAMB
Ampfing|8000576|MAPF
Amstetten NÖ|8100012|XAAS
Amstetten(W) Lokalbahn|8079075|TAM M
Amstetten(Württ)|8000577|TAM
Andorf|8100211|XAAD
Angern/March|8100619|OAANN
Annweiler am Trifels|8000582|RAN
Annweiler-Sarnstall|8005257|RANS
Ansbach|8000009|NAN
Anwanden|8000588|NAWN
Anzenkirchen|8000590|MAK
Appenweier|8000596|RAP
Arnbach|8000603|MANB
Arnoldstein|8100056|XAAR
Arnschwang|8000606|NARG
Arrach|8007343|NARR
Arzberg(Oberfr)|8000613|NAZ
Aschaffenburg Hbf|8000010|NAH
Aschaffenburg Hochschule|8000618|NAHF
Aschaffenburg Süd|8000619|NASU
Aschau(Chiemgau)|8000621|MASC
Aspang|8100188|OAAS
Asperg|8000630|TAX
Asselheim|8000625|RASH
Attnang-Puchheim|8100017|XAAT
Au im Murgtal|8000643|RWSA
Auerbach(b Mosbach, Baden)|8000649|RACH
Aufhausen(b Erding)|8000653|MAFE
Aufhausen(Württ)|8000655|TAUF
Auggen|8000657|RAUG
Augsburg Haunstetterstraße|8000658|MAHA
Augsburg Hbf|8000013|MA
Augsburg Messe|8000659|MAGM
Augsburg Morellstr.|8000660|MAMS
Augsburg-Hochzoll|8000661|MAHZ
Augsburg-Oberhausen|8000662|MAOB
Auhausen|8071103|MAUH
Aulendorf|8000014|TAU
Ausschlag-Zöbern|8100642|OAAUZ
Außenried|8000672|NAUR
Aying|8000675|MAY
Aßling(Oberbay)|8000634|MAG
Baar-Ebenhausen|8000678|MBAE
Babstadt|8000681|RBST
Bachern|8000685|MBCN
Bachheim|8000686|RBH
Backnang|8000016|TB
Bad Abbach|8000689|NBAB
Bad Aibling|8000690|MBAI
Bad Aibling Kurpark|8000696|MBAK
Bad Aussee|8100164|XABA
Bad Bellingen|8000864|RBEL
Bad Bergzabern|8000691|RBZB
Bad Birnbach|8000988|MBIB
Bad Blumau|8100663|XABB
Bad Dürkheim|8000698|RBDH
Bad Dürkheim-Trift|8000708|RBDT
Bad Empfing|8000700|MBEP
Bad Endorf|8001787|MBEF
Bad Erlach|8100192|OAER
Bad Friedrichshall Hbf|8000017|TBF
Bad Friedrichshall-Kochendorf|8000704|TBK
Bad Gastein|8100095|XABG
Bad Griesbach(Schwarzwald)|8000707|RBGR
Bad Grönenbach|8002378|MGNB
Bad Herrenalb|8007011|RHLB
Bad Hofgastein|8100097|XABH
Bad Höhenstadt|8000710|MBHT
Bad Imnau|8070309|TIMN
Bad Ischl|8100157|XAIS
Bad Kissingen|8000714|NBKI
Bad Kohlgrub|8000716|MBKG
Bad Kohlgrub Kurhaus|8000717|MBKK
Bad Krozingen|8000718|RBKR
Bad Krozingen Ost|8007330|RBKO
Bad Kötzting|8003393|NKZ
Bad Liebenzell|8000721|TBLI
Bad Mergentheim|8000724|TBMR
Bad Neusiedl am See|8100453|OABNS
Bad Neustadt(Saale)|8000730|NBNE
Bad Niedernau|8000731|TBN
Bad Peterstal|8000734|RBPL
Bad Rappenau|8000736|RBRA
Bad Rappenau Kurpark|8000777|RBPK
Bad Reichenhall|8000737|MBRL
Bad Reichenhall-Kirchberg|8000738|MBRK
Bad Rodach|8005112|NRC
Bad Rotenfels Bf|8005183|RRO
Bad Rotenfels Schloss|8005186|RROG
Bad Rotenfels Weinbrennerstraße|8005187|RROW
Bad Saulgau|8005301|TSL
Bad Schallerbach-Wallern|8100021|XASBW
Bad Schussenried|8000746|TBSC
Bad Schönborn Süd|8003533|RBS
Bad Schönborn-Kronau|8004032|RBSK
Bad Sebastiansweiler-Belsen|8000750|TBSB
Bad Staffelstein|8005670|NSFN
Bad Steben|8000756|NBST
Bad Säckingen|8005255|RSAE
Bad Teinach-Neubulach|8000757|TBT
Bad Tölz|8000758|MBT
Bad Urach|8006029|TUC
Bad Urach Ermstalklinik|8006027|TUCK
Bad Urach Wasserfall|8070680|TUCW
Bad Vigaun|8101718|XAVN
Bad Vöslau|8100708|OABV
Bad Waldsee|8000763|TBWA
Bad Waltersdorf|8100455|OABW
Bad Wildbad Bf|8006431|TWB
Bad Wildbad Kurpark|8070283|TWBK
Bad Wildbad Nord|8070281|TWBN
Bad Wildbad Uhlandplatz|8070282|TWBU
Bad Wimpfen|8000765|RBWF
Bad Wimpfen Im Tal|8000706|TBWT
Bad Wimpfen-Hohenstadt|8000766|RBWH
Bad Windsheim|8000767|NBWI
Bad Wurzach|8000769|TBW
Bad Wörishofen|8000768|MBWH
Baden b.Wien|8100025|OABA
Baden-Baden|8000774|RBB
Baden-Baden Haueneberstein|8000771|RHEB
Baden-Baden Rebland|8000775|RBBL
Bahlingen am Kaiserstuhl|8007293|RBAL
Bahlingen Riedlen|8007310|RBAR
Bahnbrücken|8007144|RBBR
Baierbrunn|8000781|MBAB
Baiersbronn Bf|8000782|RBSN
Baiersbronn Schule|8000789|RBSS
Baiersdorf|8000783|NBD
Balbersdorf|8000784|NBAF
Baldham|8000785|MBDH
Balgheim|8000787|TBLH
Balingen Süd|8000788|TBGS
Balingen(Württ)|8000353|TBG
Bamberg|8000025|NBA
Bammental|8000794|RBAM
Barabein|8079098|TBA
Barbelroth|8000802|RBRT
Basel Bad Bf|8000026|RB
Batzenhäusle|8000821|RBZE
Batzhausen|8000822|NBH
Bauerbach|8000823|RBBC
Baumgarten-Schattendorf|8100216|OABU
Baunach|8000826|NBAU
Bayerbach|8000828|MBYB
Bayerisch Eisenstein|8000830|NBEI
Bayerisch Gmain|8000831|MBGM
Bayreuth Hbf|8000028|NBY
Bayreuth-St Georgen|8000833|NBYG
Bayrischzell|8000834|MBZ
Behringersdorf|8000850|NBEH
Beimerstetten|8000858|TBS
Bellenberg|8000862|MBNB
Bellheim Am Mühlbuckel|8000861|RBLN
Bellheim Bf|8000863|RBLH
Bempflingen|8000865|TBEM
Benediktbeuern|8000869|MBEN
Benningen(Neckar)|8000873|TBEN
Beratzhausen|8000882|NBE
Berchtesgaden Hbf|8000885|MBG
Berg(Pfalz)|8000890|RBRG
Bergen(Oberbay)|8000888|MBE
Bergenweiler|8000889|TBER
Berghausen Am Stadion|8007864|RBGBS
Berghausen Hummelberg|8070020|RHUM
Berghausen Pfinzbrücke|8007863|RBGBP
Berghausen(Baden)|8000893|RBGB
Berghausen(Pfalz)|8000894|RBGP
Bergtheim|8000902|NBHM
Beringen Bad Bf|8000903|RBE
Beringerfeld|8000901|RBEF
Bermatingen-Ahausen|8000909|RBAH
Bernau a Chiemsee|8000911|MBN
Bernhardsthal|8100457|OABT
Bernried|8000918|MBER
Besigheim|8000925|TBE
Bettmannsäge|8000928|NBMS
Beuggen|8000932|RBEU
Beuron|8000933|TBEU
Beutelsbach|8000934|TBTB
Bibelöd|8000946|MBID
Biberach(Baden)|8000942|RBI
Biberach(Riß)|8000943|TBI
Biberach(Riß) Süd|8000944|TBIB
Bichl|8000945|MBIC
Bichlbach Almkopfbahn|8101972|XABIA
Bichlbach-Berwang|8100114|XABI
Bichtlingen|8077777|RBIC
Bierbaum/Safen|8100178|OABB
Bieringen|8000959|TBIE
Biessenhofen|8000962|MBIH
Bietigheim(Baden)|8000963|RBIE
Bietigheim-Bissingen|8000038|TBM
Bietingen|8000965|RBGN
Bilfingen|8000968|TBIL
Billenhausen|8000969|MBIN
Binau|8000973|RBIN
Bindlach|8000974|NBI
Binzen|8070323|RBZN
Birach|8007102|RBCH
Birkenau|8000984|RBRK
Birkenfeld(Enz)|8000986|TBIR
Bischofshofen|8100042|XABO
Bischofswiesen|8000997|MBI
Bischweier|8000998|RBIS
Bisingen|8000999|TBIS
Bittelbronn|8001002|TBIT
Bitzfeld|8001005|TBIF
Blaibach(Oberpf)|8001003|NBLA
Blaichach(Allgäu)|8001004|MBLH
Blankenloch|8001009|RBAN
Blaubeuren|8001013|TBL
Blaufelden|8001014|TBLF
Blaustein|8001015|TBLS
Bleibach|8001017|RBLB
Blindenmarkt|8100669|XABD
Blindheim|8001028|MBLM
Bludenz|8100067|XABL
Bludenz Brunnenfeld|8100699|OABUF
Bludenz-Moos|8100667|OABLM
Blumberg-Riedöschingen|8001029|RRD
Blumberg-Zollhaus|8006669|RZS
Bobenheim|8001032|RBOB
Bobingen|8001033|MBOB
Bockenheim-Kindenheim|8001043|RBOK
Bodelsberg|8001046|MBOD
Bodelshausen|8001047|TBOD
Bodenmais|8001051|NBMA
Bodenwöhr Nord|8001054|NBOE
Bogen|8001069|NBO
Bondorf(b Herrenberg)|8001080|TBD
Bopfingen|8001090|TBP
Boxberg-Wölchingen|8001111|TBOX
Brand b Litschau|8102021|PABL
Brandstätt|8001128|MBRS
Brannenburg|8001129|MBB
Braunau/Inn|8100365|XABR
Bregenz|8100090|XAB
Bregenz Hafen|8101950|XABHF
Bregenz Riedenburg|8100473|XARD
Breisach|8001143|RBRS
Breitenbrunn(Schwab)|8001147|MBRN
Breitendiel|8001148|NBRE
Breitengüßbach|8001149|NBG
Breitenschützing|8100695|OABTZ
Bretten|8000053|RBT
Bretten Kupferhälde|8070093|RBTK
Bretten Rechberg|8001138|RBTN
Bretten Schulzentrum|8001144|RBTS
Bretten Stadtmitte|8001152|RBTM
Bretten Wannenweg|8079060|RBTW
Bretten-Ruit|8001131|RBTI
Bretzfeld|8001178|TBZ
Brigachtal Kirchdorf|8003339|RMBK
Brigachtal Klengen|8003336|RKLN
Brixen im Thale|8100366|XABT
Brixlegg|8100101|XABX
Bruchhausen(b Ettlingen)|8001198|RBRH
Bruchsal|8000055|RBR
Bruchsal Am Mantel|8001214|RBMT
Bruchsal Bildungszentrum|8001197|RBRZ
Bruchsal Schlachthof|8070009|RBRF
Bruchsal Schloßgarten|8085001|RBRD
Bruchsal Sportzentrum|8001212|RBRP
Bruchsal Stegwiesen|8085002|RBRC
Bruchsal Tunnelstraße|8070008|RBRE
Bruck-Fusch|8100047|XABF
Bruck/Leitha|8100198|XABK
Bruck/Mur|8100032|XABM
Bruckberg|8001203|MBR
Brucken|8001205|TBRU
Bruckmühl|8001207|MBRM
Bruderndorf b.Langschlag|8100680|OABRF
Bruderndorf b.Langschlag Wasserstation|8100915|PABLW
Brunnen(Oberbay)|8001265|MBRU
Bräunlingen Bahnhof|8001119|RBRN
Bräunlingen Industriegebiet|8070999|RBRI
Brötzingen Mitte|8004799|TPB
Brötzingen Sandweg|8070274|TPBS
Brötzingen Wohnlichstraße|8070275|TPBW
Bubenreuth|8001223|NBTH
Buchbrunn-Mainstockheim|8001225|NBM
Buchen Ost|8001226|RBUO
Buchen(Odenw)|8001227|RBUN
Buchenau(Oberbay)|8001229|MBAU
Buchenhain|8001231|MBHA
Buchholz(Baden)|8001234|RBU
Buchloe|8000057|MBU
Buggingen|8001262|RBGG
Burgau(Schwab)|8001276|MBGU
Burgbernheim|8001277|NBUM
Burgbernheim-Wildbad|8001278|NBUW
Burgfried b.Gnas|8100697|XABU
Burghausen|8001284|MBUH
Burgheim|8001285|MBGH
Burgkirchen|8001288|MBGK
Burgkunstadt|8001289|NBK
Burglauer|8001290|NBUR
Burgsinn|8001293|NBN
Burgstall(Murr)|8001296|TBU
Burgthann|8001297|NBUT
Burgweiler|8001281|TBUW
Burkheim-Bischoffingen|8007289|RBBN
Burladingen|8007226|TBLD
Burladingen West|8070022|TBLW
Busenbach|8007000|RBUS
Buttenheim|8001310|NBT
Bäumenheim|8000778|MBHM
Böbingen(Rems)|8005979|TBB
Böblingen|8001055|TBO
Böblingen Danziger Str|8085005|TBO T
Böblingen Heusteigstr|8085007|TBO H
Böblingen Südbf|8085006|TBOS
Böblingen Zimmerschlag|8085008|TBO Z
Böbrach|8070667|NBOB
Böckingen Sonnenbrunnen|8070159|TBCS
Böckingen West|8070158|TBCW
Böckstein|8100094|XABS
Bödigheim|8001056|RBGH
Böheimkirchen|8100661|XABC
Böhl-Iggelheim|8001057|RBOE
Böhmhof|8001058|NBHF
Böhringen-Rickelshausen|8001059|RBER
Bötzingen|8007296|RBTZ
Bötzingen Mühle|8007297|RBTU
Büchenbach|8001242|NBUE
Bühl(Baden)|8001252|RBUE
Cadolzburg|8001317|NCA
Calmbach Bahnhof|8001320|TCA
Calmbach Süd|8070280|TCAS
Calw|8000063|TCW
Calw|8098063|TCWB
Cham(Oberpf)|8001330|NCH
Chamerau|8001331|NCHA
Coburg|8001338|NC
Coburg Nord|8001334|NCN
Coburg-Beiersdorf|8001333|NCBD
Coburg-Neuses|8001339|NCNS
Collenberg|8005028|NRF
Crailsheim|8000067|TC
Creidlitz|8001347|NCR
Creußen(Oberfr)|8001348|NCRE
Cronheim|8071105|MCRO
Dachau Bahnhof|8001354|MDA
Dachau Stadt|8001355|MDAS
Dallau|8001366|RDL
Darching|8001373|MDAR
Dasing|8001382|MDAG
Dechantskirchen|8100722|OADK
Deggendorf Hbf|8001397|NDG
Deidesheim|8001399|RDM
Deining(Oberpf)|8001400|NDE
Deisenhofen|8001404|MDS
Deißlingen Mitte|8001405|TDLM
Denzlingen|8001415|RDZ
Dettelbach Bahnhof|8001421|NDEB
Dettenhausen|8085015|TDH
Dettingen Freibad|8001424|TDTUF
Dettingen Gsaidt|8001426|TDTUG
Dettingen Lehen|8001422|TDTUL
Dettingen(Teck)|8001428|TDT
Dettingen-Mitte|8070679|TDTU
Deuerling|8001430|NDN
Deutsch Wagram|8100721|OADEW
Deutschkreutz|8100719|OADEK
Diebach|8001435|NDIE
Diedelsheim|8070012|RBTD
Diedorf(Schwab)|8001439|MDID
Dietersheim|8001450|NDT
Dietmanns b.Gmünd|8100726|OADMS
Dietmannsried|8001454|MDRD
Dietzelbach|8007335|RDB
Dießen|8001447|MDIN
Dillingen(Donau)|8001463|MDIL
Dingolfing|8001466|MDIF
Dinkelsbühl Bf|8070352|MDKB
Dinkelscherben|8001468|MDKS
Distelhausen|8001472|TDIH
Dittigheim|8001474|TDM
Ditzingen|8001476|TDI
Dogern|8001491|RDRN
Dollnstein|8001495|MDO
Dombühl|8000365|NDB
Donaueschingen|8000077|RDO
Donaueschingen Allmendshofen|8001479|RDOA
Donaueschingen Aufen|8001482|RDOF
Donaueschingen Grüningen|8001483|RDOG
Donaueschingen Mitte/Siedlung|8001485|RDOM
Donauwörth|8000078|MDT
Dorfen Bahnhof|8001499|MDFN
Dorfgastein|8100098|XADG
Dorfprozelten|8001503|NDP
Dornbirn|8100122|XADO
Dornbirn Schoren|8100728|XADS
Dornstetten|8001512|TDS
Dornstetten-Aach|8001510|TDSA
Dottenheim|8001548|NDM
Dotternhausen-Dormettingen|8029358|TDOD
Draßburg|8100220|OADR
Drösing|8100221|OADI
Durach|8001614|MDUH
Durmersheim|8001616|RDRM
Durmersheim Nord|8070170|RDUN
Dußlingen|8001617|TDU
Döggingen|8001480|RDGN
Döhlau|8001481|NDAU
Dörfles-Esbach|8001484|NDOE
Dürnkrut|8100724|OADKT
Dürrenbüchig|8001576|RDBG
Dürrenwaid Bahnhof|8070805|NDW
Dürrnhaar|8001578|MDHR
Ebelsbach-Eltmann|8001619|NEE
Eben im Pongau|8100140|XAEB
Ebenfurth|8100225|XAEF
Ebenhausen(Unterfr)|8001620|NEBH
Ebenhausen-Schäftlarn|8001621|MEBS
Ebenhofen|8001622|MEBH
Ebensfeld|8001623|NED
Eberbach|8000369|REA
Ebermannstadt|8001627|NEBM
Ebermergen|8001628|MEBM
Ebern|8001629|NEB
Ebersbach(Fils)|8001632|TEC
Ebersberg(Oberbay)|8001634|MEG
Ebersdorf(b Coburg)|8001636|NEC
Ebertsheim|8001638|RET
Ebing|8001640|NEG
Ebreichsdorf|8100226|OAED
Ebringen|8001643|REBR
Eching|8001647|MEC
Echterdingen|8001650|TETD
Eckartshausen-Ilshofen|8001651|TEI
Eckersmühlen|8001655|NEMN
Edelfingen|8001660|TED
Edenkoben|8001663|REK
Edesheim(Pfalz)|8001665|REH
Edling|8001669|MEDL
Edlitz-Grimmenstein|8100189|OAEGS
Efringen-Kirchen|8001671|REF
Egersdorf|8001674|NEGE
Eggenburg|8100201|OAEB
Eggenfelden|8001677|MEGF
Eggenfelden Mitte|8001676|MEFM
Eggenstein Bf|8007173|REG
Eggingen|8070866|RUEG
Egglkofen|8001678|MEGK
Eggmühl|8001679|MEGM
Eggolsheim|8001680|NEO
Eglharting|8001682|MEGL
Egling|8001683|MELG
Ehingen(Donau)|8001684|TEH
Ehningen(b Böblingen)|8001689|TEHN
Ehrwald Zugspitzbahn|8100089|XAEZ
Eichenau(Oberbay)|8001702|MEIC
Eicholzheim|8001707|REM
Eichstetten am Kaiserstuhl|8007295|RE
Eichstätt Bahnhof|8001708|MEB
Eichstätt Stadt|8001709|MEST
Eimeldingen|8001715|REI
Eisenberg(Pfalz)|8001728|REIS
Eisenheim|8070856|NEHM
Eisenärzt|8001725|MEZT
Eislingen(Fils)|8001731|TEF
Eiswoog|8001732|REIW
Eitensheim|8001734|MEI
Elfershausen-Trimberg|8001742|NELF
Ellental|8001746|TBME
Ellhofen|8001747|TELL
Ellingen(Bay)|8001749|NEL
Ellwangen|8001751|TEL
Ellzee|8001752|MELZ
Elpersheim|8001754|TELP
Elsbethen|8100772|XAEL
Eltersdorf|8001762|NEF
Elzach|8001766|RELZ
Emmendingen|8001771|REMM
Emskirchen|8001783|NEK
Endersbach|8001785|TEN
Endingen am Kaiserstuhl|8007285|REN
Endingen(Württ)|8029356|TEND
Engen|8001790|RENG
Engertsham|8001792|MEGH
Engstingen|8070456|TKL
Engstingen Schulzentrum|8003335|TENS
Engstlatt|8001794|TENG
Enns|8100011|XAEN
Entringen|8001802|TENT
Enzberg|8001803|TEZ
Enzisweiler|8001806|MENW
Eppingen|8000373|REP
Eppingen West|8079077|REPW
Erbach(Württ)|8001820|TER
Erding|8001825|MER
Erdmannhausen|8001827|TERD
Erdweg|8001829|MEWG
Ergenzingen|8001833|TEG
Ergoldsbach|8001835|MERB
Eriskirch|8001838|TEK
Erkersreuth|8001840|NERK
Erlangen|8001844|NER
Erlangen Paul-Gossen-Straße|8001846|NERS
Erlangen-Bruck|8001845|NERH
Erlenbach(Main)|8001848|NERL
Ernsgaden|8001853|MERG
Erpolzheim|8001860|RERO
Ersingen|8001861|TERS
Ersingen West|8079090|TERW
Erzingen(Baden)|8001865|RERZ
Erzingen(Württ)|8029357|TERZ
Eschelbronn|8007443|RESN
Eschenau(b Heilbronn)|8001874|TESU
Eschenau(Mittelfr)|8001875|NESU
Eschenau/Salzach|8100770|XAEU
Eschenbach(b Markt Erlbach)|8001877|NESB
Eschenlohe|8001880|MECH
Escherndorf-Vogelsburg|8070857|NESD
Esslingen(Neckar)|8001920|TE
Esslingen-Mettingen|8001921|TEME
Esslingen-Zell|8006642|TEZL
Esting|8001996|MESG
Etterzhausen|8001925|NET
Ettlingen Stadt|8007007|RETT
Ettlingen West|8001926|RETL
Etzelwang|8001929|NEW
Etzenbach|8007334|REZB
Etzenricht|8001932|NEZ
Etzenrot|8007008|RETZ
Eubigheim|8001933|TEU
Euerdorf|8001935|NEU
Eugendorf|8100774|XAED
Eutingen im Gäu|8000101|TET
Eutingen Nord|8001944|TETN
Eutingen(Baden)|8001942|TEB
Eyach|8001946|TEY
Eßleben|8001919|NEN
Faak am See|8100084|XAFS
Fahrnau|8001954|RFN
Farchant|8001961|MFCH
Fasanenpark|8001963|MFP
Faulbach(Main)|8001964|NFCH
Faurndau|8001965|TFAU
Favoritepark|8001967|TFV
Fehring|8100176|OAFE
Feilitzsch|8001969|NFZ
Feldafing|8001970|MFA
Feldbach/Raab|8100175|OAF
Feldberg-Bärental|8001971|RFB
Feldkirch|8100197|XAFK
Feldkirch Amberg|8100791|OAFKA
Feldkirchen in Kärnten|8100039|XAFT
Feldkirchen(b München)|8001973|MFK
Feldolling|8001966|MFOL
Felixdorf|8100780|XAFX
Fellbach|8001974|TFE
Feucht|8001978|NFT
Feucht Ost|8001988|NFTO
Feucht-Moosbach|8002520|NFTM
Feuchtwangen Bf|8070601|MFWG
Fichtenberg|8001982|TFI
Fieberbrunn|8100053|XAFB
Filderstadt|8001984|TFIL
Finningerstraße|8001985|MFNS
Finsterwald|8007889|MGMF
Fischbach(Nürnberg)|8001989|NFIH
Fischbachau|8001992|MFBU
Fischen|8001995|MFN
Fischhaus|8070806|NFHA
Fischhausen-Neuhaus|8001998|MFIN
Fladungen|8002001|NFD
Flaurling|8100795|XAFG
Flehingen|8002005|RFL
Flintsbach|8002012|MFLI
Flomersheim|8002014|RFLO
Flughafen Wien|8100353|XAWIF
Forbach(Schwarzw)|8002022|RFCH
Forchheim Nord|8003892|NFON
Forchheim(b Karlsruhe)|8002023|RFM
Forchheim(Oberfr)|8002024|NFO
Fornsbach|8002026|TFB
Forsting|8002028|MFOS
Forth|8002029|NFH
Frahelsbruck|8007344|NFHB
Frankenmarkt|8100018|XAFA
Frankenstein(Pfalz)|8002036|RFST
Frankenthal Hbf|8000332|RFT
Frankenthal Süd|8002025|RFTS
Frastanz|8100069|XAFR
Frauenalb-Schielberg|8007010|RFS
Frauenau|8002057|NFU
Frauenkirchen|8100238|OAFRK
Freiberg(Neckar)|8002065|TFG
Freiburg Klinikum|8002077|RFK
Freiburg Messe/Universität|8000453|RFMU
Freiburg(Breisgau) Hbf|8000107|RF
Freiburg-Herdern|8002067|RFHE
Freiburg-Landwasser|8002066|RFLW
Freiburg-Littenweiler|8002068|RFLT
Freiburg-St Georgen|8002069|RFSG
Freiburg-Wiehre|8002070|RFWI
Freiburg-Zähringen|8002071|RFZ
Freihalden|8002074|MFHD
Freihung|8002076|NFRE
Freihöls|8002075|NFR
Freilassing|8000108|MFL
Freilassing-Hofham|8002085|MFLH
Freinsheim|8000374|RFHM
Freising|8002078|MFR
Freistadt|8100239|OAFRS
Fremdingen Bf|8070392|MFRD
Freudenberg-Kirschfurt|8002089|NFM
Freudenstadt Hbf|8000110|TFS
Freudenstadt Industriegebiet|8002087|TFSI
Freudenstadt Schulzentrum|8002090|TFSZ
Freudenstadt Stadt|8002091|TFSS
Freyung Bf|8002094|NFY
Frickenhausen|8007446|TFKH
Frickenhausen Kelterstraße|8090022|TFKHK
Fridingen(b Tuttlingen)|8002096|TFD
Fridolfing|8002097|MFDF
Friedberg in der Steiermark|8100185|OAFR
Friedberg(Augsburg)|8002099|MFDB
Friedburg|8100241|XAFI
Friedrichshafen Flughafen|8002120|TFFL
Friedrichshafen Hafen|8002110|TFH
Friedrichshafen Landratsamt|8002122|TFLA
Friedrichshafen Ost|8002030|TFOS
Friedrichshafen Stadt|8000112|TF
Friedrichshafen-Fischbach|8002111|TFF
Friedrichshafen-Kluftern|8003345|TKLU
Friedrichshafen-Manzell|8003850|TMAN
Friedrichstal b Freudenstadt|8002126|RFRT
Friedrichstal(Baden)|8002116|RFTL
Friedrichsthal(b Bayreuth)|8002118|NFSB
Friesach in Kärnten|8100076|XAF
Friesenheim(Baden)|8002123|RFH
Fritzens-Wattens|8100104|XAFW
Frohnleiten|8100033|OAFO
Frommern|8002133|TFR
Furschenbach|8007005|RFU
Furth b.Mattighofen|8100814|XAFH
Furth im Wald|8002159|NFW
Furth(b Deisenhofen)|8002161|MFU
Föderlach|8100797|XAFC
Förbau|8002019|NFOE
Förtschendorf|8002020|NFDF
Fürnitz|8100368|XAFU
Fürsteneck|8070809|NFUE
Fürstenfeld|8100177|OAFFD
Fürstenfeldbruck|8002141|MFB
Fürstenzell|8002146|MFZL
Fürth Westvorstadt|8002149|NFWS
Fürth(Bay)Hbf|8000114|NF
Fürth(Odenw)|8002150|RFUE
Fürth-Burgfarrnbach|8002152|NFBB
Fürth-Dambach|8002153|NFDB
Fürth-Klinikum|8002154|NFKL
Fürth-Unterfürberg|8002155|NFUF
Füssen|8002156|MFSN
Gablingen|8002162|MGAL
Gaggenau Bf|8002167|RGG
Gaggenau Mercedes-Benz Werk|8006733|RDAI
Gaildorf West|8002168|TGAW
Gaimersheim|8002171|MGH
Gaisbach-Wartberg|8100246|OAGSW
Gaishorn|8100819|OAGAH
Gaißach|8002173|MGAI
Gamburg(Tauber)|8002177|TGAM
Gammertingen|8007229|TGMT
Gammertingen Europastraße|8070382|TGME
Garching(Alz)|8002184|MGA
Garmisch-Partenkirchen|8002187|MGP
Garmisch-Partenkirchen Hausberg|8002188|MGPH
Gars(Inn)|8002189|MGS
Gattendorf|8100332|OAGTX
Gaubüttelbrunn|8002195|TGRN
Gausbach|8002197|RGBA
Gauselfingen|8007227|TGSF
Gauting|8002198|MGT
Geigant|8002205|NGET
Geinberg|8100830|XAGEI
Geiselhöring|8002209|MGLG
Geisenbrunn|8002210|MGIB
Geisenhausen|8002211|MGHS
Geisingen|8002214|RGSN
Geisingen-Aulfingen|8002200|RGA
Geisingen-Hausen|8002204|RGHA
Geisingen-Kirchen|8002213|RGK
Geisingen-Leipferdingen|8002215|RGL
Geislingen(Steige)|8002218|TG
Geislingen(Steige)West|8002217|TGW
Geitau|8002220|MGEU
Geltendorf|8000119|MGE
Gemmingen|8002228|TGEM
Gemmingen West|8071001|TGEW
Gemünden(Main)|8000120|NGM
Genderkingen|8002233|MGKG
Gendorf|8002234|MGND
Gengenbach|8002235|RGB
Georgensgmünd|8002237|NGE
Geradstetten|8002240|TGES
Gerhausen|8002242|TGEH
Gerlachsheim|8002243|TGLH
Gerlenhofen|8002244|MGLH
Gerling im Pinzgau|8100879|XAGE
Germering-Unterpfaffenhofen|8006006|MUG
Germersheim|8000376|RGE
Germersheim Mitte/Rhein|8002239|RGEH
Germersheim Süd/Nolte|8002241|RGES
Gernlinden|8002247|MGLD
Gernsbach Bf|8002248|RGS
Gernsbach Mitte|8002250|RGSD
Geroldshausen|8002251|TGN
Gerstetten|8007075|TGSN
Gersthofen|8002256|MGHF
Gessertshausen|8002263|MGHN
Giengen(Brenz)|8002272|TGB
Gießenbach in Tirol|8100549|XAGB
Gilching-Argelsried|8002275|MGCH
Gingen(Fils)|8002278|TGI
Glanzstoffwerke|8002287|NGLW
Gleisdorf|8100195|OAGL
Gloggnitz|8100026|XAGL
Gmund(Tegernsee)|8007631|MGMD
Gmünd NÖ|8100129|XAGN
Gmünd NÖ Böhmzeil|8102020|PABGK
Gniebing|8100857|OAGNI
Gochsheim(Baden)|8007143|RGOM
Godramstein|8002300|RGOR
Goldberg(Württ)|8005201|TGOL
Goldshöfe|8000380|TGL
Golling-Abtenau|8100041|XAGA
Gols|8100255|OAGOL
Gomadingen|8070400|TGOM
Gondelsheim Schlossstadion|8070011|RGOS
Gondelsheim(Baden)|8002326|RGO
Gosberg|8002329|NGG
Gottenheim|8002334|RGH
Gotteszell|8002335|NGZ
Gottmadingen|8002337|RG
Goßmannsdorf|8002333|NGOD
Graben(Lechfeld)Gewerbepark|8002346|MGRL
Graben-Neudorf|8000131|RGN
Graben-Neudorf Nord|8002345|RGNN
Grafenaschau|8002343|MGRA
Grafenau|8002344|NGFU
Grafendorf bei Hartberg|8100182|OAGD
Grafenwiesen|8007339|NGFW
Grafing Bahnhof|8002347|MGB
Grafing Stadt|8002348|MGRS
Grafling-Arzting|8002349|NGFA
Grafrath|8002351|MGF
Gramatneusiedl|8100369|XAGR
Gratwein-Gratkorn|8100370|XAGG
Graz Don Bosco (Bahnsteige 1-2)|8103490|PALVO
Graz Hbf|8100173|XAG
Graz Ostbahnhof-Messe|8100371|XAGO
Graz-Liebenau Murpark|8103487|OAGLM
Grenzach|8002365|RGRZ
Gries am Brenner|8100258|XAGRB
Gries im Pinzgau|8100892|XAGI
Griesen(Oberbay)|8017041|MGRI
Grieskirchen-Gallspach|8100022|XAGP
Grieswirt|8100907|OAGWT
Grießen(Baden)|8002373|RGSS
Grombach|8002380|RGM
Gronsdorf|8002383|MGDF
Großarmschlag|8002399|NGRS
Großgerungs|8100839|OAGGE
Großgeschaidt|8002416|NGRG
Großhelfendorf|8002420|MGHD
Großhesselohe Isartalbf|8002422|MGOI
Großkarolinenfeld|8002424|MGK
Großwalbur|8002432|NGRW
Großweikersdorf|8100906|OAGWE
Grub am Forst|8002434|NGUF
Grub(Oberbay)|8002435|MGRB
Grub(Oberpf)|8002436|NGRU
Grunbach|8002448|TGC
Gräfelfing|8002339|MGFL
Gräfenberg|8002340|NGFG
Gräfendorf|8002341|NG
Gröbenzell|8002377|MGRZ
Gröbming|8100135|XAGM
Grötzingen|8000381|RGZ
Grötzingen Krappmühlenweg|8007861|RGZK
Grötzingen Oberausstraße|8079057|RGZO
Grünsfeld|8002447|TGRS
Grünstadt|8000137|RGR
Grünstadt Nord|8002444|RGRN
Grüntal-Wittlensweiler|8002445|TGRW
Gstadt(Wanderbahn)|8070669|NSDT
Gumpenried-Asbach|8070599|NGPA
Gundelfingen(Bay)|8002466|MGUF
Gundelfingen(Breisgau)|8002465|RGDN
Gundelsdorf|8002467|NGD
Gundelshausen|8002468|NGU
Gundelsheim(Neckar)|8002470|RGUN
Gunskirchen|8100845|OAGKN
Guntersdorf|8100894|OAGTD
Guntramsdorf Kaiserau|8100372|XAGK
Gunzenhausen|8000385|NGUN
Gurten OÖ|8100263|XAGUR
Gussenstadt|8007074|TGSS
Gutach Freilichtmuseum|8002480|RGTF
Gutach(Breisgau)|8002478|RGTA
Gänserndorf|8100245|XAGD
Gärtringen|8002165|TGT
Gäufelden|8002166|TGFD
Gölshausen|8002307|RGOE
Gölshausen Industriegebiet|8002306|RGOI
Göpfritz an der Wild|8100200|XAGPF
Göppingen|8000127|TGO
Görschnitz|8002312|NGOE
Götzendorf/Leitha|8100254|XAGT
Götzis|8100120|XAGZ
Gültstein|8070604|TGU
Gündlkofen|8002457|MGKF
Günzach|8002458|MGNZ
Günzburg|8000139|MGZB
Haar|8002491|MHR
Hagelstadt|8002506|NHA
Hagenau im Innkreis|8100914|XAHU
Hagenbach|8002515|RHGB
Hagenbüchach|8002517|NHBH
Hagsfeld Bahnhof|8003185|RKHA
Haidenaab-Göppmannsbühl|8002523|NHAG
Haiding|8100265|OAHA
Haidkapelle|8070414|THKP
Haigerloch|8070415|THGL
Haiming|8100956|XAHM
Hainstadt(Baden)|8002529|RHAI
Halbmeil|8002533|RHAM
Halfing|8070801|MHLF
Hall in Tirol|8100105|XAHT
Hallbergmoos|8002534|MHMO
Hallein|8100040|XAHL
Hallein Burgfried|8102049|PANEU
Hallstadt(b Bamberg)|8002542|NHAH
Hallwang-Elixhausen|8100929|XAHE
Haltingen|8002546|RHL
Hammelburg|8002567|NHG
Hammelburg Ost|8002568|NHGO
Hammerau|8002570|MHAU
Hammerstein|8070419|RHST
Hanfertal|8007235|THFT
Happurg|8002578|NHAP
Harburg(Schwab)|8002593|MHRH
Hard-Fussach|8100267|XAHA
Hardhof|8002596|NHHF
Harsdorf|8002605|NH
Hart b. Graz|8102050|PAHA
Hartberg|8100180|OAHB
Hartershofen|8002609|NHAR
Harthaus|8002610|MHHS
Hartmannshof|8002612|NHS
Haselbrunn|8077771|RRZB
Haselstauden (Dornbirn)|8100981|OAHSS
Haslach|8002621|RHS
Hasloch(Main)|8002622|NHCH
Haspelmoor|8002623|MHMR
Hatlerdorf(Dornbirn)|8100921|OAHAT
Hatting in Tirol|8100986|XAHI
Hatzendorf|8100268|OAHZ
Haubersbronn|8007192|THAU
Haubersbronn Mitte|8070078|THAM
Haupeltshofen|8002651|MHPH
Haus im Ennstal|8100136|XAHAS
Hausach|8000333|RHA
Hausen i Tal|8002656|THAT
Hausen(Schwab)|8002664|MHNS
Hausen-Raitbach|8002666|RHSN
Hausen-Starzeln|8007225|THSS
Hausham|8002667|MHHM
Haßfurt|8002630|NHT
Haßloch(Pfalz)|8002632|RHLO
Haßmersheim|8002633|RHAS
Hebertsfelden|8002671|MHEF
Hebertshausen|8006189|MHSN
Hechingen|8002673|THCH
Hechingen Landesbahn|8082673|THIL
Heddesheim/Hirschberg|8002430|RGCH
Hedersdorf|8002678|NHED
Hegne|8002683|RHGN
Heidelberg Hbf|8000156|RH
Heidelberg Orthopädie|8002684|RHBO
Heidelberg-Altstadt|8002685|RHKA
Heidelberg-Kirchheim/Rohrbach|8002686|RHKM
Heidelberg-Pfaffengrund/Wieblingen|8002687|RHBP
Heidelberg-Schlierbach/Ziegelhausen|8005366|RSR
Heidelberg-Weststadt/Südstadt|8002681|RHBF
Heidelsheim|8002688|RHI
Heidelsheim Nord|8070010|RHIO
Heidenheim|8002689|THD
Heidenheim Voithwerk|8070005|THDV
Heidenheim-Mergelstetten|8002690|THDM
Heidenheim-Schnaitheim|8002691|THDS
Heigenbrücken|8002696|NHEI
Heilbr.-Böckingen Berufsschulzentrum|8079631|TBCB
Heilbronn Finanzamt|8070791|TH  A
Heilbronn Friedensplatz|8070792|TH  F
Heilbronn Hans-Rießer-Straße|8072723|THSTR
Heilbronn Harmonie|8070172|TH  H
Heilbronn Harmonie/Hafenmarktpassage|8071172|TH  W
Heilbronn Harmonie/Kunsthalle|8072172|TH  O
Heilbronn Hauptbahnhof/Willy-Brandt-Pl.|8070171|TH  B
Heilbronn Hbf|8000157|TH
Heilbronn Industrieplatz|8002723|THSTI
Heilbronn Karlstor|8002697|THKT
Heilbronn Kaufland|8002726|TNSK
Heilbronn Neckarturm|8070174|TH  P
Heilbronn Pfühlpark|8070793|TH  U
Heilbronn Rathaus|8070173|TH  R
Heilbronn Sülmertor|8002699|THST
Heilbronn Technisches Schulzentrum|8072722|THSTS
Heilbronn Theater|8002722|TH  T
Heilbronn Trappensee|8002700|TTPS
Heiligenstatt(Obb)|8002703|MHEI
Heiligenstein(Pfalz)|8002704|RHN
Heilsbronn|8002705|NHE
Heimenkirch|8002710|MHMK
Heimerdingen|8007328|THMD
Heimstetten|8002715|MHEM
Heinfels|8105982|PAARF
Heitersheim|8002727|RHE
Heiterwang-Plansee|8100550|XAHP
Helmbrechts|8002733|NHB
Helmsheim|8002734|RHSM
Helmstadt(Baden)|8007444|RHM
Hemmingen|8007327|THMG
Hemsbach|8002748|RHCH
Henfenfeld|8002751|NHD
Herbertingen|8000160|THT
Herbertingen Ort|8002760|THTO
Herbertshofen|8002761|MHEH
Herblingen|8002762|RHRB
Herbolzheim(Breisg)|8002763|RHZ
Herbolzheim(Jagst)|8002764|THZ
Herbrechtingen|8002766|THC
Hergatz|8000387|MHGZ
Hermaringen|8002776|THMA
Hermentingen|8007231|THMT
Heroldsberg|8002782|NHER
Heroldsberg Nord|8002783|NHEN
Herrenberg|8002785|THE
Herrenberg Zwerchweg|8002786|TZWE
Herrlingen|8002789|THL
Herrlishöfen|8079099|THH
Herrsching|8002792|MHI
Hersbruck(l Pegnitz)|8002793|NHL
Hersbruck(r Pegnitz)|8002794|NHR
Herten(Baden)|8002797|RHRT
Herxheim am Berg|8002798|RHXB
Herzogenburg|8100272|XAHB
Heselbach|8002808|RHBA
Hettingen(Hohenz)|8007230|THTN
Hetzmannsdorf-Wullersdorf|8100936|OAHEW
Heufeld|8002820|MHEU
Heufeldmühle|8002821|MHFM
Hildbrandsgrün|8002827|NHGN
Hilpertsau|8002837|RHLT
Hilpoltstein|8002838|NHP
Himmelreich|8002844|RHIM
Himmelstadt|8002845|NHIS
Hinrichssegen|8002850|MHRS
Hinterzarten|8002848|RHIZ
Hirsau|8002852|THI
Hirschaid|8002853|NHI
Hirschbach b.Gmünd|8100953|OAHIR
Hirschfelden|8002856|MHFN
Hirschhorn(Neckar)|8002857|RHO
Hochdorf(b Horb)|8000389|THF
Hochfilzen|8100052|XAHF
Hochhausen(Tauber)|8002871|THO
Hochstadt-Marktzeuln|8002878|NHM
Hochstetten|8007201|RHOS
Hochstetten Grenzstraße|8079042|RHOSG
Hochwang|8002881|MHWG
Hochzirl|8100111|XAHO
Hockenheim|8002883|RHK
Hof Hbf|8002924|NHO
Hof(Münstertal)|8007336|RHOF
Hof-Neuhof|8002927|NHON
Hofen(b Aalen)|8002930|THOF
Hoffenheim|8002931|RHFF
Hohenau|8100130|XAHH
Hohenbrugg an der Raab|8100945|OAHHR
Hohenbrunn|8002940|MHOB
Hohenems|8100121|XAHS
Hohenpeißenberg|8002954|MHPG
Hohenschäftlarn|8002955|MHSL
Hohenstadt(Mittelfr)|8002956|NHOH
Hohenwarth|8007342|NHWN
Hohenwarth Campingplatz|8070160|NHWNC
Hollabrunn|8100274|OAHL
Holzgerlingen Bf|8085010|THZG
Holzgerlingen Buch|8085011|THZGB
Holzgerlingen Hülben|8085009|THZGN
Holzkirchen|8002980|MHO
Hopfgarten im Brixental|8100059|XAHG
Hopfgarten im Brixental Berglift|8100939|XAHGB
Hoppingen|8002994|MHOP
Horb|8000177|THB
Horb-Heiligenfeld|8002998|THBH
Hornberg(Schwarzw)|8003001|RHBG
Hoßkirch Königseggsee|8003004|THKS
Hubacker|8003010|RHAR
Hufschlag|8003023|MHUF
Huglfing|8003024|MHUG
Hugstetten|8003025|RHU
Hulb|8003022|THUB
Huttenheim|8003033|RHTT
Huzenbach|8003034|RHUB
Höchstädt(Donau)|8002888|MHDT
Höfen(Enz) Bf|8002891|THOE
Höfen(Enz) Nord|8070279|THON
Höfingen|8002892|THFG
Höhenkirchen-Siegertsbrunn|8002894|MHSB
Höllenthal|8002898|NHTL
Höllriegelskreuth|8002899|MHRK
Höpfling|8002908|MHPF
Hörden|8002910|RHOR
Hörlkofen|8002912|MHLK
Hörpolding|8002914|MHPD
Hörsching|8100974|XAHOG
Hösbach|8002918|NHOE
Hötzelsdorf-Geras|8100273|OAHZD
Hüffenhardt|8007439|RHFH
Hüfingen Mitte|8003014|RHFM
Hüttau|8100993|XAHUT
Hütten|8070219|THTT
Ibach|8003035|RIB
Ichenhausen|8003038|MIHN
Icking|8003039|MIC
Iffeldorf|8005672|MSTA
Igensdorf|8003044|NIDF
Igersheim|8003045|TIH
Ihringen|8003052|RIR
Illertissen|8003057|MILT
Illesheim|8003058|NILL
Illingen(Württ)|8003060|TIL
Immendingen|8000182|RIM
Immendingen Mitte|8003061|RIMM
Immendingen Zimmern|8003066|RIMZ
Immenreuth|8003063|NIM
Immenstadt|8003065|MIMS
Imst-Pitztal|8100062|XAIP
Imsterberg|8101000|XAIB
Ingolstadt Audi|8003074|MIA
Ingolstadt Hbf|8000183|MIH
Ingolstadt Nord|8003076|MIN
Inningen|8003079|MINI
Innsbruck Hbf|8100108|XAI
Innsbruck Hötting|8100110|XAIH
Innsbruck Messe|8105987|PAIM
Innsbruck Westbahnhof|8100109|XAIW
Insheim|8003080|RIN
Inzing/Inn|8101007|XAIZ
Iphofen|8003081|NI
Ipsheim|8003083|NIP
Irnfritz|8100399|OAIF
Irrenlohe|8003086|NIR
Ismaning|8003092|MIS
Ispringen|8003094|TIP
Istein|8003098|RIT
Ittersbach Bahnhof|8007014|RITB
Ittersbach Rathaus|8090001|RITBR
Ittling|8003100|NIL
Ittlingen|8003101|RITL
Itzelberg|8003103|TIT
Jagstzell|8003111|TJZ
Jechtingen|8007288|RJ
Jedenspeigen|8101012|OAJE
Jenbach|8100102|XAJB
Jenbach Zillertalbahn|8100545|XAJBZ
Jennersdorf|8101010|OAJD
Jettenbach|8003122|MJEB
Jettingen|8003123|MJET
Jockgrim Bf|8003125|RJO
Jossa|8003129|NJS
Judenburg|8100073|XAJ
Julbach|8003136|MJUL
Jungingen(Hohenz)|8007223|TJUH
Jungnau|8007234|TJNU
Jägerhaus|8003106|MJGS
Jöhlingen|8003127|RJL
Jöhlingen West|8079058|RJLW
Kainzenbad|8003146|MKAI
Kalchreuth|8003154|NKAL
Kalsdorf b.Graz|8101019|XAKAL
Kaltenberg|8070973|MKBG
Kaltenbrunnen im Montafon|8100282|OAKAL
Kalteneck|8070807|NKCK
Kalwang|8100126|XAK
Kammern im Liesingtal|8101061|OAKMN
Kandel|8003172|RKD
Kandern|8070450|RKA
Kapellen-Drusweiler|8003175|RKPD
Kapfenberg|8100031|XAKP
Kappelrodeck|8007004|RKPP
Kappelrodeck Ost|8077004|RKPO
Kapsweyer|8007859|RKPW
Karlsdorf|8003181|RKF
Karlsruhe Albtalbahnhof|8079045|RKAB
Karlsruhe Bahnhofsvorplatz|8079041|RKV
Karlsruhe Durlacher Tor / KIT-Campus Süd|8079125|RKDT
Karlsruhe Entenfang|8079126|RKEF
Karlsruhe Hbf|8000191|RK
Karlsruhe Hbf Südausgang|8089390|RK  S
Karlsruhe Marktplatz (Pyramide U)|8079046|RKMAP
Karlsruhe Mühlburger Tor|8079144|RKMT
Karlsruhe West|8003183|RKW
Karlsruhe-Durlach|8003184|RKDU
Karlsruhe-Kniel. Rheinbergstr.|8079128|RKSR
Karlsruhe-Knielingen|8003186|RKIN
Karlsruhe-Mühlburg|8003187|RKMG
Karlsruhe-Neureut Kirchfeld|8079047|RKNEK
Karlstadt(Main)|8003189|NKA
Karpfham|8003191|MKH
Kastl(Oberbay)|8003205|MKAT
Katsdorf|8101029|OAKAT
Katzwang|8003214|NKG
Kaufbeuren|8000194|MKFB
Kaufering|8000195|MKFG
Kefermarkt|8100536|OAKFM
Kehl|8003218|RKL
Kehlen|8003220|TKEH
Kellmünz|8003227|MKMZ
Kematen in Tirol|8101038|XAKM
Kemnath-Neustadt|8003229|NKNN
Kempten(Allgäu)Hbf|8000197|MKP
Kempten(Allgäu)Ost|8003230|MKPO
Kenzingen|8003233|RKN
Kersbach|8003238|NKCH
Kiebingen|8003248|TKBI
Kiefersfelden|8003249|MKI
Killer|8007224|TKLR
Kimpling|8101045|OAKIM
Kindberg|8100030|XAKB
Kinding(Altmühltal)|8003256|MKIG
Kirchanschöring|8003263|MKAG
Kirchberg in Tirol|8100057|XAKG
Kirchberg(Murr)|8003266|TKIM
Kirchbichl|8100290|XAKL
Kirchdorf/Krems|8100170|XAKK
Kirchehrenbach|8003268|NKIR
Kirchenlaibach|8000201|NKL
Kirchenlamitz Ost|8003270|NKO
Kirchentellinsfurt|8003272|TKI
Kirchheim(Neckar)|8003278|TKM
Kirchheim(Teck)|8003280|TKT
Kirchheim(Teck)-Ötlingen|8003282|TKTO
Kirchheim(Teck)Süd|8003283|TKTS
Kirchheim(Unterfr)|8003284|TKU
Kirchheim(Weinstr)|8003285|RKH
Kirchseeon|8003290|MKO
Kirchweidach|8084066|MKW
Kirchzarten|8003293|RKZ
Kirnbach-Grün|8007104|RKBG
Kirschbaumwasen|8003289|RKBV
Kissing|8003299|MKIS
Kittsee|8100373|XAKIT
Kitzbühel|8100055|XAKI
Kitzbühel Hahnenkamm|8101044|XAKIH
Kitzbühel Schwarzsee|8101593|OASSE
Kitzingen|8000479|NKN
Kißlegg|8000203|TKG
Klagenfurt Hbf|8100085|XAKT
Klais|8003302|MKLA
Klaus in Vorarlberg|8101100|OAKV
Kledering b.Wien|8101051|XAKE
Kleinberghofen|8003317|MKHN
Kleingemünden|8003329|NKGM
Kleinheubach|8003324|NKLH
Kleinkems|8003325|RKES
Kleinkötz|8003326|MKKZ
Kleinsteinbach|8003331|RKBA
Kleinwallstadt|8003334|NKT
Klingenberg(Main)|8003337|NKM
Klingenbrunn|8003338|NKNB
Kloster Bronnbach|8001193|TBR
Klosterlechfeld|8003342|MKLF
Klosterreichenbach|8003343|RKLB
Knittelfeld|8100072|XAKF
Knittlingen-Kleinvillars|8003332|TKNK
Knöringen-Essingen|8003349|RKG
Kochel|8003355|MKCH
Kohlstetten|8070458|TKOS
Kolbermoor|8003397|MKMR
Kolbnitz|8100091|XAKO
Kollmarsreute|8003398|RKLR
Kollnau|8003399|RKNA
Konstanz|8003400|RKO
Konstanz Hafen|8073400|RKOH
Konstanz-Fürstenberg|8003404|RKOF
Konstanz-Petershausen|8003401|RKOP
Konstanz-Wollmatingen|8003416|RKOW
Kork|8003408|RKOR
Korneuburg|8100293|OAKOB
Korntal|8003409|TKO
Korntal Gymnasium|8007855|TKO G
Kornwestheim Pbf|8003411|TKH
Kothmaißling|8003413|NKMG
Kranebitten|8100551|XAKA
Krems an der Donau|8100295|XAKD
Kressbronn|8003432|TKN
Kressbronn Hafen|8073432|RKRB
Kreuzstraße|8003438|MKZ
Kronach|8003446|NK
Krumbach(Schwab)|8003457|MKRB
Krumbach(Schwab)Schule|8001179|MKRS
Krumpendorf/Wörthersee|8100079|XAKR
Kuchen|8003461|TKUC
Kuchl|8100546|XAKU
Kuchl Garnei|8102047|PASEQ
Kufstein|8100001|XAKN
Kulmbach|8003476|NKU
Kumpfmühl|8101063|OAKMU
Kundl|8100100|XAKUN
Kuppenheim|8003480|RKU
Kutzenhausen|8003483|MKUN
Köditz|8003356|NKI
Köfering|8003357|NKOE
Köndringen|8003374|RKOE
Königsbach(Baden)|8003376|TKB
Königsbronn|8003378|TKS
Königschaffhausen|8007286|RKHS
Königshofen(Baden)|8003381|TKF
Köstendorf Weng|8100594|XAWEG
Kühnsdorf-Klopeiner See|8100336|XAKKS
Küps|8003472|NKUE
Laa/Thaya|8101180|XALAA
Laaber|8003485|NLB
Laberweinting|8003488|MLBW
Ladenburg|8003489|RLD
Lagerlechfeld|8003490|MLLF
Lahr(Schwarzw)|8003494|RLSW
Laineck|8003495|NLCK
Lam|8007345|NLAM
Lambach|8100015|XALB
Lambach Markt|8101223|OAMLB
Lambrecht(Pfalz)|8003497|RLBP
Lambsheim|8003498|RLSH
Landau(Isar)|8003506|MLDI
Landau(Pfalz)Hbf|8000216|RLA
Landau(Pfalz)Süd|8003507|RLAD
Landau(Pfalz)West|8003508|RLW
Landeck-Zams|8100063|XALE
Landsberg(L)Schule|8005389|MLLS
Landsberg(Lech)|8003512|MLL
Landshut(Bay)Hbf|8000217|MLA
Landshut(Bay)Süd|8003514|MLAS
Langdorf|8003521|NLG
Langen am Arlberg|8100065|XALA
Langenargen|8003524|TLR
Langenau(Württ)|8003525|TLL
Langenbach(Oberbay)|8003528|MLB
Langenbrand|8003532|RLBD
Langenprozelten|8003548|NLP
Langensteinbach Bahnhof|8007013|RLSB
Langenwang(Schwab)|8003551|MLNW
Langenzenn|8003552|NLZ
Langkampfen|8100300|XALK
Langlau|8003554|NLGU
Langquaid(b Eggmühl)|8070812|MLQU
Langschlag b.Großgerungs|8101176|OALSG
Langweid(Lech)|8003560|MLAW
Lasberg-St. Oswald|8101178|OALSO
Laubendorf|8003567|NLDF
Lauchheim|8003569|TLH
Lauchringen|8004552|RLAU
Lauchringen West|8003562|RLAC
Lauda|8000221|TL
Laudenbach am Main|8003573|NLK
Laudenbach(Bergstr)|8003571|RLCH
Laudenbach(Württ)|8003572|TLC
Lauf West|8003587|NLLW
Lauf(links Pegnitz)|8003580|NLL
Lauf(rechts Pegnitz)|8003581|NLR
Laufach|8003582|NLA
Laufen(Oberbay)|8003584|MLF
Laufenburg(Baden)|8003585|RLFG
Laufenburg(Baden)Ost|8003586|RLBO
Lauffen(Neckar)|8003588|TLN
Lauingen|8003589|MLIG
Laupheim Stadt|8003591|TLM
Laupheim West|8003592|TLW
Lautenbach(Baden)|8003594|RLBA
Lauterach|8100302|XALAH
Laßnitzhöhe|8100194|OALH
Laßnitzthal|8101161|OALNT
Legelshurst|8003609|RLT
Leibnitz|8100035|XALZ
Leinfelden|8003622|TLF
Leingarten|8003623|TLG
Leingarten Mitte|8071003|TLGM
Leingarten Ost|8070157|TLGO
Leingarten West|8003624|TLGW
Leipheim|8003627|MLEH
Leithen b.Seefeld|8100554|XALT
Lend|8100045|XALND
Lengau|8102009|XALEG
Lengenwang|8003639|MLWG
Lenggries|8003643|MLG
Lenzing|8101141|XALEZ
Leoben Hbf|8100070|XALO
Leobersdorf|8101163|OALOD
Leogang|8100051|XALG
Leonberg|8003652|TLE
Leonding|8101165|OALOG
Leopoldshafen Leopoldstraße|8007174|RLEO
Lermoos|8100552|XALM
Leuterschach|8003663|MLSH
Leutershausen-Wiedersbach|8003664|NLWI
Leutkirch|8000336|TLK
Lichtenfels|8000228|NLF
Lichtenthal|8003676|NLH
Lienz in Osttirol|8100141|XALI
Liezen|8100131|XALZN
Limberg-Maissau|8101154|OALIM
Limburgerhof|8003687|RLI
Lindach|8003690|RLID
Lindau-Aeschach|8003692|MLIA
Lindau-Insel|8000230|MLI
Lindau-Reutin|8003693|MLIR
Lingenfeld|8003702|RLF
Linkenheim Rathaus|8079018|RLING
Linsenhofen|8007447|TLSH
Linz Hbf|8100013|XAL
Linz/Donau Franckstraße|8100807|OAFRR
Linz/Donau Wegscheid|8101195|XALW
Litschau|8195426|PASKR
Lochau-Hörbranz|8100124|XALH
Lochham|8003720|MLCH
Lohgarten-Roth|8003734|NLOR
Lohhof|8003735|MLH
Lohr Bahnhof|8003740|NLO
Lonsee|8003748|TLON
Loosdorf b.Melk|8101169|XALDF
Loppenhausen|8003749|MLOH
Lorch(Württ)|8003752|TLO
Lorüns|8101175|OALRU
Loßburg-Rodt|8003758|RLOS
Ludersheim|8003762|NLHM
Ludesch|8100066|XALU
Ludwigsburg|8000235|TLU
Ludwigschorgast|8003763|NLS
Ludwigshafen(Bodensee)|8003764|RLU
Ludwigshafen(Rh)Hbf|8000236|RL
Ludwigshafen(Rhein) BASF Mitte|8000308|RLBM
Ludwigshafen(Rhein) BASF Nord|8087060|RLBN
Ludwigshafen(Rhein) BASF Süd|8002056|RLBS
Ludwigshafen(Rhein) Mitte|8003759|RLSM
Ludwigshafen(Rhein) Oppau|8070167|RLOP
Ludwigshafen-Mundenheim|8003765|RLUM
Ludwigshafen-Oggersheim|8003766|RLO
Ludwigshafen-Rheingönheim|8003767|RLUR
Ludwigshöhe|8003768|NLUD
Ludwigsstadt|8003770|NLUS
Ludwigsthal|8003771|NLT
Luhe|8003794|NLU
Luhe-Wildenau|8003795|NLW
Lungitz/Gusen|8101185|OALUN
Lustenau|8100123|XALUU
Lähn|8100553|XALN
Löcherberg|8003721|RLOE
Lödersdorf|8101164|OALOF
Löffingen|8003724|RLGN
Lörrach Dammstraße|8003736|RLRD
Lörrach Hbf|8003729|RLR
Lörrach Museum/Burghof|8003737|RLRS
Lörrach Schwarzwaldstraße|8003743|RLRW
Lörrach-Brombach/Hauingen|8001191|RBRM
Lörrach-Haagen/Messe|8002489|RHAG
Lörrach-Stetten|8003730|RLST
Lörzenbach-Fahrenbach|8003731|RLFB
Löwental|8003733|TLOE
Magstadt|8003807|TMAG
Maichingen|8003808|TMAI
Maichingen Nord|8003834|TMIN
Maikammer-Kirrweiler|8003809|RMKI
Mainleus|8003813|NML
Mainroth|8003814|NMRH
Maisach|8003824|MMA
Maishofen-Saalbach|8100050|XAMS
Malching(Oberbay)|8003828|MMAG
Mallersdorf|8003830|MMD
Mallnitz-Obervellach|8100093|XAMO
Malmsheim|8003831|TMAL
Malsch|8003832|RMS
Malsch Süd|8003833|RMSU
Mammendorf|8004204|MMAM
Manndorf|8003839|NMDF
Mannheim ARENA/Maimarkt|8003841|RMSM
Mannheim Handelshafen/Jungbusch|8006508|RMHH
Mannheim Hbf|8000244|RM
Mannheim-Friedrichsfeld Süd|8003842|RMFS
Mannheim-Käfertal|8003843|RMKL
Mannheim-Luzenberg|8006509|RMLB
Mannheim-Neckarau|8003844|RMN
Mannheim-Neckarstadt|8006511|RMNS
Mannheim-Rheinau|8003845|RMA
Mannheim-Seckenheim|8003847|RMSE
Mannheim-Waldhof|8003848|RMW
Marbach Ost (Villingen-Schwenningen)|8003857|RMBO
Marbach West(Villingen-Schwenningen)|8003854|RMBW
Marbach(b Münsingen)|8070481|TMBM
Marbach(Neckar)|8003853|TMB
Marbach-Grafeneck|8003851|TGRA
Marchegg|8100466|XAMG
Marchtrenk|8101204|XAMR
Margertshausen Bf|8003858|MMGH
Maria Rain|8003859|MMRN
Markdorf(Baden)|8003871|RMAD
Markelfingen|8003872|RMAR
Markelsheim|8003873|TMA
Markt Bibart|8003876|NMB
Markt Erlbach|8003878|NMER
Markt Indersdorf|8003072|MIDR
Markt Schwaben|8003879|MSB
Marktbreit|8003881|NMT
Marktl|8003883|MMK
Marktleuthen|8003884|NMH
Marktoberdorf|8003885|MMO
Marktoberdorf Nord|8003889|MMON
Marktoberdorf Schule|8003877|MMOS
Marktplatz, Karlsruhe|8079035|RKMAK
Marktredwitz|8000247|NMR
Marktschorgast|8003887|NMSG
Marstetten-Aitrach|8003897|TMAR
Martinlamitz|8003898|NMLZ
Martinszell(Allgäu)|8003901|MMSZ
Marxgrün|8003903|NMX
Marxzell|8007009|RMX
Marzling|8003905|MMZG
Maselheim|8079119|TMSM
Massing|8003910|MMSG
Matrei am Brenner|8100106|XAM
Mattighofen|8100409|XAMAH
Matzing|8003912|MMTZ
Maubach|8003913|TMAU
Mauer(b Heidelberg)|8003915|RMAU
Mauerkirchen|8100410|XAMK
Maulbronn Stadt/Kloster|8003918|TMBS
Maulbronn West|8087080|TMW
Maulburg|8003920|RMLG
Mausheim|8003921|NMSM
Mautern im Liesingtal|8100125|XAMT
Mauthaus|8070804|NMAU
Maxau|8084068|RMAX
Maxhütte-Haidhof|8003922|NMXH
Maximiliansau Eisenbahnstraße|8003923|RMAL
Maximiliansau West|8084067|RMAW
Maximiliansau-Im Rüsten|8003911|RMAI
Mayrhofen im Zillertal|8100541|XAMY
Meckenbeuren|8003930|TMK
Meckesheim|8003932|RMK
Meeder|8003938|NMEE
Meitingen|8003952|MMEI
Melk|8100005|XAME
Mellrichstadt Bf|8003959|NME
Memmingen|8000249|MM
Mengen|8003969|TMG
Menningen-Leitishofen|8077779|RMEN
Menzingen(Baden)|8007145|RMZN
Merching|8003979|MMEG
Mering|8003982|MMR
Mering-St Afra|8004008|MSAF
Merklingen - Schwäbische Alb|8003983|TMKL
Mertesheim|8003988|RME
Mertingen Bahnhof|8003989|MMTG
Metzingen(Württ)|8004009|TME
Metzingen-Neuhausen|8070678|TNHU
Meßkirch|8077778|RMSS
Michelau(Oberfr)|8004011|NMI
Michelau(Württ)|8007194|TMIC
Michelaubrück|8004013|NMIK
Micheldorf|8100412|XAMI
Miedelsbach-Steinenberg|8007193|TMST
Miesbach|8004019|MMIB
Miltach|8004026|NMLT
Miltenberg|8000640|NM
Mimberg|8004028|NMIM
Mindelaltheim|8004030|MMAH
Mindelheim|8000338|MMH
Mining|8100478|XAMN
Mittelsinn|8004040|NMSN
Mittenwald|8004043|MMW
Mitterberghütten|8101219|XAMH
Mitterdorf-Veitsch|8101221|XAMV
Mittergars|8004046|MMIG
Mittewald an der Drau|8100417|OAMIW
Mixnitz-Bärenschützklamm|8101210|XAMIX
Mochenwangen|8004049|TMO
Mogersdorf|8101231|OAMOG
Monbach-Neuhausen|8004077|TMON
Moosbierbaum-Heiligeneich|8100376|XAMB
Moosburg|8004084|MMB
Moosrain|8007630|MMRI
Morlesau|8004090|NMOU
Mosbach West|8004095|RMOW
Mosbach(Baden)|8004094|RMO
Mosbach-Neckarelz|8000264|RNZ
Muggensturm|8004178|RMU
Muggensturm Badesee|8004192|RMU B
Muhr am See|8000534|NMS
Munderfing|8100489|XAMF
Munderkingen|8004182|TMU
Murg(Baden)|8004184|RMRG
Murnau|8004185|MMU
Murnau Ort|8004186|MUO
Murrhardt|8004188|TMT
Musau|8100555|XAMU
Mußbach|8004189|RMCH
Mägerkingen|8070480|TMGK
Möckmühl|8004050|TML
Mödling|8101230|OAMOD
Mögglingen(Gmünd)|8004053|TMOE
Möhringen Bahnhof|8004068|TMHB
Möhringen Rathaus|8004067|TMHR
Mönchhof-Halbturn|8100484|OAMHH
Mönchröden|8004064|NMOE
Mörlenbach|8004066|RMOE
Mössingen|8004070|TMS
Möttingen|8004071|MMTN
Mötz|8101237|XAMTZ
Mühlacker|8000339|TM
Mühlacker Rößlesweg|8004103|TMRO
Mühldorf(Oberbay)|8000258|MMF
Mühldorf-Möllbrücke|8100087|XAMM
Mühlen(b Horb)|8004104|TMUE
Mühlhausen(b Engen)|8004107|RMH
Mühlheim am Inn|8101248|XAMHM
Mühlheim(b Tuttlingen)|8004111|TMUL
Mühlstetten|8004115|NMST
Mühringen|8070494|TMRN
Müllendorf|8100424|OAML
Müllheim im Markgräflerland|8004124|RML
Münchberg|8004126|NMBG
München Donnersbergerbrücke|8004128|MMDN
München Flughafen Besucherpark|8004167|MFHB
München Flughafen Terminal|8004168|MFHM
München Hackerbrücke|8004129|MHAB
München Harras|8004130|MHAR
München Hbf|8000261|MH
München Hbf (tief)|8098263|MHT
München Hbf Gl.27-36|8098261|MH  N
München Hbf Gl.5-10|8098262|MH  S
München Heimeranplatz|8005419|MHP
München Hirschgarten|8004179|MMHG
München Isartor|8004131|MIT
München Karlsplatz|8004132|MKA
München Leienfelsstr.|8004133|MLEF
München Leuchtenbergring|8004134|MLEU
München Marienplatz|8004135|MMP
München Ost|8000262|MOP
München Rosenheimer Platz|8004136|MRP
München Siemenswerke|8004137|MSW
München St.Martin-Str.|8004138|MMAR
München Süd|8099501|MS
München-Allach|8004140|MMAL
München-Aubing|8004141|MMAU
München-Berg am Laim|8004142|MOP O
München-Daglfing|8004143|MDFG
München-Englschalking|8004144|MEGS
München-Fasanerie|8004145|MFAS
München-Fasangarten|8004146|MFG
München-Feldmoching|8004147|MFE
München-Freiham|8004181|MFHH
München-Giesing|8004148|MGI
München-Johanneskirchen|8004149|MJK
München-Karlsfeld|8004150|MKFS
München-Laim|8004151|ML
München-Langwied|8004152|MLW
München-Lochhausen|8004153|MLO
München-Mittersendling|8004154|MMT
München-Moosach|8004155|MMCH
München-Neuaubing|8004156|MNA
München-Neuperlach Süd|8006696|MNPS
München-Obermenzing|8004157|MOZ
München-Pasing|8004158|MP
München-Perlach|8004159|MPER
München-Riem|8004160|MRI P
München-Solln|8004161|MSN
München-Trudering|8004162|MTR
München-Untermenzing|8004139|MAUG
München-Westkreuz|8004163|MWKR
Münchingen|8007325|TMCG
Münchingen Rührberg|8070220|TMCR
Münchsmünster|8004165|MMST
Münnerstadt|8004169|NMUE
Münsingen|8070495|TMN
Münster-Wiesing|8100488|XAMW
Münstertal(Schwarzwald)|8007337|RUM
Münzesheim|8007142|RMZH
Münzesheim Ost|8007146|RMZO
Mürzzuschlag|8100029|XAMZ
Nabburg|8004191|NNAB
Nagold|8004196|TNA
Nagold Stadtmitte|8004201|TNA M
Nagold-Iselshausen|8004202|TNAI
Nagold-Steinberg|8004195|TNAS
Naila|8004198|NNIL
Nassenbeuren|8004207|MNBN
Neckarbischofsheim Helmhof|8007435|RNBH
Neckarbischofsheim Nord|8077434|RNHF
Neckarbischofsheim Stadt|8007434|RNHS
Neckarburken|8004215|RNB
Neckargemünd|8000265|RNM
Neckargemünd Altstadt|8004217|RNMA
Neckargerach|8004216|RNA
Neckarhausen bei Neckarsteinach|8004218|RNH
Neckarsteinach|8004219|RNT
Neckarsulm|8004220|TN
Neckarsulm Mitte|8004232|TN  M
Neckarsulm Nord|8004238|TNSN
Neckarsulm Süd|8004226|TN  S
Neckarzimmern|8004222|RNEZ
Nehren|8004229|TNEH
Neidenfels|8079146|RNFL
Neidenstein|8007441|RNST
Nellmersbach|8004233|TNL
Nendeln|8101262|XAND
Nendingen(b Tuttlingen)|8004235|TNED
Nenzing|8100068|XANE
Nenzingen|8077772|RNN
Nersingen|8004239|MNSG
Nesselwang|8004240|MNEW
Nettingsdorf|8101265|XANF
Neu-Edingen/Friedrichsfeld|8000631|RMF
Neu-Ulm|8006730|MNM
Neubiberg|8004252|MNB
Neuburg(Donau)|8004254|MNBD
Neuburg(Kammel)|8004256|MNBK
Neuburg(Rhein)|8004257|RNBU
Neubäu|8004250|NNAE
Neudenau|8004258|TND
Neudorf b.Parndorf|8100388|OANEF
Neuenburg(Baden)|8089119|RNBG
Neuenbürg(Enz)|8004265|TNE
Neuenbürg(Enz) Freibad|8070276|TNEB
Neuenbürg(Enz) Süd|8004264|TNES
Neuenbürg(Enz)-Rotenbach Eyachbrücke|8070278|TNEE
Neuendettelsau|8004268|NNDU
Neuenmarkt-Wirsberg|8000267|NNE
Neuenstein|8004276|TNN
Neufahrn(b Freising)|8004279|MNF
Neufahrn(Niederbay)|8000688|MNFR
Neufeld/Leitha|8100495|OANE
Neuffen|8007448|TNEF
Neufra(Hohenz)|8007228|TNFH
Neugilching|8004249|MNGH
Neuhaus(Pegnitz)|8004284|NNP
Neuhausen Bad Bf|8004289|RNHN
Neuhausen(b Landshut)|8026358|MNHL
Neuhausmühle|8071117|NNHM
Neukirchen b.Lambach|8101278|OANLB
Neukirchen(b Sulzb)|8000269|NNS
Neukirchen(Inn)|8004298|MNK
Neukirchen-Gampern|8101260|OANEG
Neulußheim|8004304|RNL
Neumarkt am Wallersee|8100134|XANKW
Neumarkt(Oberpf)|8004305|NNT
Neumarkt-Kallham|8100023|XANK
Neumarkt-St Veit|8000720|MNR
Neunagelberg|8114529|PAKYX
Neunkirch|8004308|RNK
Neunkirchen a Sand|8004310|NNKS
Neunkirchen NÖ|8101277|OANKO
Neuratting|8101288|XANG
Neuses(b Kronach)|8004319|NNEU
Neusiedl am See|8100434|OANEU
Neusorg|8004321|NNSG
Neustadt(Aisch)Bahnhof|8004323|NNA
Neustadt(Aisch)Mitte|8004336|NNAM
Neustadt(b Coburg)|8004325|NNU
Neustadt(Donau)|8004326|MND
Neustadt(Schwarzw)|8004331|RNSS
Neustadt(Waldnaab)|8004332|NNW
Neustadt(Weinstr) Süd|8004306|RND
Neustadt(Weinstr)Hbf|8000275|RN
Neustadt-Böbig|8004489|RNBO
Neustadt-Hohenacker|8004333|TNHO
Neustift(b Passau)|8084074|NNSP
Neusäß|8004318|MNES
Neuwirtshaus(Porscheplatz)|8004338|TNW
Neuötting|8004315|MNN
Nickelsdorf|8100499|OANC
Niederarnbach|8071875|MNAR
Niederbiegen|8004363|TNB
Niederlindhart|8004391|MNLH
Niederraunau|8004401|MNRU
Niederroth|8004404|MNRO
Niederstetten|8004412|TNI
Niederstotzingen|8004413|TNS
Niederwinden|8004423|RNID
Niederöblarn|8101273|OANIO
Niefern|8004425|TNF
Niklashausen|8004437|TNK
Nimburg(Baden)|8007294|RNIM
Nonnenhorn|8004446|MNHN
Nordendorf|8004451|MNOD
Nordhalben Bf|8004455|NNOH
Nordheim v. d. Rhön|8071974|NNOR
Nordheim(Württ)|8004458|TNO
Norsingen|8004464|RNO
Nufringen|8004490|TNUF
Nußberg-Schönau|8070668|NNBS
Nördlingen|8000280|MNL
Nürnberg Frankenstadion|8004493|NSTD
Nürnberg Frankenstadion Sonderbahnsteig|8098493|NND
Nürnberg Hbf|8000284|NN
Nürnberg Nordost|8004469|NNRO
Nürnberg Ost|8004471|NNO
Nürnberg Ostring|8004470|NNOS
Nürnberg Rothenburger Str.|8004473|NNRS
Nürnberg-Dutzendteich|8004476|NDTH
Nürnberg-Dürrenhof|8004442|NDHF
Nürnberg-Eibach|8004477|NNES
Nürnberg-Erlenstegen|8004478|NNER
Nürnberg-Gleißhammer|8005304|NGLH
Nürnberg-Laufamholz|8004480|NNLH
Nürnberg-Mögeldorf|8004481|NNMO
Nürnberg-Rehhof|8004491|NNRH
Nürnberg-Reichelsdorf|8004483|NNRE
Nürnberg-Sandreuth|8004484|NNSR
Nürnberg-Schweinau|8004485|NNSW
Nürnberg-Stein|8004486|NNST
Nürnberg-Steinbühl|8004487|NNSE
Nürtingen|8004488|TNU
Nürtingen-Roßdorf|8090021|TNU R
Nürtingen-Vorstadt|8090020|TNUV
Nüziders|8101289|OANU
Oberachern|8007002|ROA
Oberachern Bindfadenfabrik|8007003|ROAB
Oberaichen|8004496|TOAI
Oberalm|8102006|XAOA
Oberammergau|8004503|MOA
Oberasbach|8004504|NOA
Oberau|8004506|MOU
Oberaudorf|8004507|MOD
Oberboihingen|8004517|TOBB
Oberdachstetten|8004521|NON
Oberderdingen-Flehingen|8079078|ROBE
Oberelchingen|8004525|TOLC
Oberesslingen|8004528|TOES
Oberferrieden|8004529|NOB
Obergimpern|8007437|ROGI
Obergries|8004531|MOGS
Obergriesbach|8004532|MOGB
Oberhaid|8004533|NOH
Oberharmersbach Dorf|8007105|ROHD
Oberharmersbach-Riersbach|8007106|ROHR
Oberhofen im Inntal|8102053|XAOB
Oberhofen-Zell am Moos|8101332|OAOZM
Oberkirch|8004545|ROB
Oberkirch-Köhlersiedlung|8004546|ROBK
Oberkochen|8004549|TON
Oberkotzau|8000287|NOKP
Oberkrozingen|8007331|ROK
Oberlenningen|8004553|TOL
Oberlindhart|8004554|MOLH
Obernau|8004558|NOBN
Obernberg-Altheim|8100442|XAOM
Obernburg-Elsenfeld|8004560|NOE
Oberndorf in Tirol|8101792|OAWOB
Oberndorf(Neckar)|8004563|TOB
Oberottmarshausen|8004571|MOMN
Oberrotweil|8007290|ROBL
Oberschefflenz|8004577|ROSC
Oberschleißheim|8004580|MOSM
Obersinn|8004583|NOBS
Oberstaufen|8004584|MOSF
Oberstdorf|8004585|MOF
Obertrattnach-Markt Hofkirchen|8101325|OAOTM
Obertraubling|8004592|NOT
Obertsrot|8004594|ROT
Oberwerrn|8004453|NOBW
Oberwinden|8004603|ROD
Oberzell|8004605|TOBZ
Oberöwisheim|8007141|ROOE
Obing|8070803|MOBG
Ochenbruck|8004609|NOK
Ochsenfurt|8000818|NOF
Ochsenhausen|8079093|TOC
Odenheim Bf|8007138|RODH
Odenheim West|8070099|RODW
Oerlenbach|8004629|NOER
Oettingen(Bay)|8070508|MOET
Offenau|8004643|ROU
Offenburg|8000290|RO
Offenburg Kreisschulzentrum|8004639|ROKS
Offenhausen|8070509|TOFS
Offingen|8004654|MOFF
Oftering|8101308|OAOF
Oftersheim|8004658|ROFH
Ohlstadt|8004662|MOH
Olching|8004667|MOL
Oppenau|8004679|ROP
Oppenweiler(Württ)|8004681|TOP
Orschweier|8004683|RORW
Osterburken|8000295|TO
Osterhofen(Nby)|8004700|NOS
Osterhofen(Oberbay)|8004701|MOSH
Ostermünchen|8004703|MOM
Ostheim v Rhön|8004711|NOMR
Ostrach Bahnhof|8070628|TOR
Ottenau|8004722|ROTU
Ottenhofen(Oberbay)|8004723|MONH
Ottenhofen-Bergel|8004724|NOBE
Ottenhöfen|8007006|ROTT
Ottenhöfen West|8007015|ROTW
Ottensoos|8004725|NOTS
Otterfing|8004726|MOTF
Otting|8004730|MOTG
Otting-Weilheim|8004731|MOTW
Ottobeuren|8004732|MOTB
Ottobrunn|8004733|MOBR
Otzing|8004738|NOZ
Owen(Teck)|8004740|TOW
Oy-Mittelberg|8004742|MOYM
Paindorf|8004747|MPD
Pama|8100543|OAPAM
Pamhagen|8100448|OAPA
Pankofen|8004749|NPK
Pappenheim|8004753|MPP
Parndorf|8101335|XAPD
Parndorf Ort|8100515|OAPO
Parsberg|8004755|NPB
Partenstein|8004756|NPAR
Pasching|8101389|OAPSG
Passau Hbf|8000298|NPA
Paternion-Feistritz Bahnhst|8100086|XAPT
Patersdorf|8070665|NPAD
Patsch|8101337|XAPA
Payerbach-Reichenau|8100027|OAP
Pechbrunn|8004758|NPE
Peggau-Deutschfeistritz|8100034|XAPG
Pegnitz|8004759|NPZ
Peiting Nord|8004764|MPTN
Peiting Ost|8004765|MPTO
Peiß|8004761|MPEI
Peißenberg|8004762|MPBG
Peißenberg Nord|8004763|MPBN
Penzberg|8004767|MPZ
Perkam|8004770|MPRM
Petersaurach|8004774|NPET
Petersaurach Nord|8004797|NPEN
Petershausen(Obb)|8004775|MPE
Peterskirchen|8101399|XAPK
Pfaffenhausen|8004780|MPFH
Pfaffenhofen(Ilm)|8004781|MPF
Pfaffenschwendt|8101351|OAPFS
Pfarrkirchen|8004786|MPKI
Pfarrwerfen|8101353|XAPFW
Pfettrach|8026355|MPFT
Pflach|8100556|XAPL
Pflaumloch|8004796|TPF
Pforzheim Hbf|8000299|TPH
Pforzheim Maihälden|8004804|TPHM
Pforzheim-Weißenstein|8004801|TPW
Pfraundorf(Inn)|8004802|MPFR
Pfreimd|8004803|NPD
Pfronten-Ried|8004806|MPFD
Pfronten-Steinach|8004807|MPFS
Pfronten-Weißbach|8004809|MPFW
Pfullendorf|8070630|TPU
Pfäffingen|8004778|TPG
Philippsburg(Baden)|8004813|RPB
Pichl b.Schladming|8101356|XAPC
Piding|8004815|MPI
Pill-Vomperbach|8100524|XAPV
Pinggau Markt|8100186|OAPG
Pinzberg|8004820|NPI
Pittenhart|8072764|MPTH
Planegg|8004827|MPL
Platt|8101367|OAPLT
Plattling|8000301|NPL
Pleinfeld|8004835|NPLF
Plochingen|8000302|TP
Plüderhausen|8004842|TPL
Pocking|8004845|MPKG
Poikam|8004853|NPOI
Poing|8004854|MPO
Pommelsbrunn|8004858|NPMH
Poppenhausen|8004865|NPOP
Possenhofen|8004874|MPH
Postbauer-Heng|8004875|NPOH
Pottschach|8101390|OAPSH
Pram-Haag|8100526|XAPM
Pregarten|8100528|XAPR
Pressath|8004880|NPS
Pressig-Rothenkirchen|8004881|NPR
Pretzfeld|8004882|NPRE
Prien am Chiemsee|8004885|MPR
Prinzersdorf|8101387|XAPRD
Prosselsheim|8070858|NPM
Pruggern|8101386|OAPRU
Puch b.Hallein Urstein|8102054|PAWIV
Puch bei Hallein|8101406|XAPO
Puchheim|8004893|MPM
Pulgarn|8101405|OAPUL
Pullach|8004899|MPUL
Pulling(b Freising)|8004900|MPU
Pusarnitz|8101373|XAPZ
Puschendorf|8004901|NPU
Pöchlarn|8100006|XAPN
Pölling|8004847|NPG
Pöndorf|8101377|OAPON
Pörtschach am Wörther See|8100080|XAPW
Pösing|8004849|NPOE
Pürbach-Schrems|8100531|OAPBS
Raaba|8100193|XAMD
Rabensburg|8101416|OARAB
Radersdorf|8004914|MRDD
Radldorf(Niederbay)|8004917|NRA
Radolfzell|8000880|RRZ
Radstadt|8100138|XARA
Rain|8004922|MRN
Raindorf|8004923|NRAF
Raisting|8004925|MRAG
Raitersaich|8004926|NRAH
Ramerberg|8004928|MRMB
Rammingen(Bay)|8004927|MRAM
Rammingen(Württ)|8004930|TRM
Ramsbach Birkhof|8004931|RRBI
Ramsbach Höfle|8004932|RRBH
Ramsberg|8004933|NRAB
Ramsen|8004935|RRN
Ramsenthal|8004936|NRSL
Rangendingen|8070520|TRGD
Rankweil|8100119|XARW
Rastatt|8000306|RRA
Rastatt Beinle|8004944|RRAB
Rattenberg-Kramsach|8100465|XARK
Raubling|8004955|MRA
Raumünzach|8004961|RRMZ
Ravensburg|8004965|TRB
Rebdorf-Hofmühle|8004966|MRH
Rechtenstein|8004968|TRC
Reckendorf|8004971|NRDF
Redl-Zipf|8101428|OARED
Rednitzhembach|8004978|NRCH
Redwitz(Rodach)|8004979|NRZ
Regen|8004981|NREG
Regensburg Hbf|8000309|NRH
Regensburg-Burgweinting|8001298|NBWH
Regensburg-Prüfening|8004983|NRPF
Regenstauf|8004987|NRGF
Rehau|8004988|NRU
Reichelsdorfer Keller|8004994|NREK
Reichenau(Baden)|8004997|RRU
Reichenbach(b. Ettlingen)|8007012|RRBA
Reichenbach(Fils)|8004999|TRF
Reichenberg(Unterfr)|8005002|TRCB
Reichenschwand|8005005|NREI
Reichersbeuern|8005007|MRCH
Reichertshausen(Ilm)|8005008|MRS
Reichertshofen(Schwab) Bf|8005010|MRFS
Reicholzheim|8005011|TRL
Reihen|8005013|RRIN
Reilsheim|8005015|RRHM
Reinstetten|8079094|TRTT
Reisen(Hess)|8005026|RRSH
Reith b.Seefeld|8100112|XARE
Rekawinkel|8101432|XARWL
Renchen|8005037|RR
Renningen|8000313|TRX
Renningen Süd|8005001|TRXS
Rentweinsdorf|8005045|NREN
Retz|8100469|XAREZ
Retzbach-Zellingen|8005049|NREZ
Reuth(b Erbendorf)|8005050|NRT
Reutlingen Hbf|8000314|TRE
Reutlingen West|8005052|TREW
Reutlingen-Betzingen|8005053|TREB
Reutlingen-Sondelfingen|8005054|TRES
Reutte in Tirol|8100115|XART
Reutte in Tirol Schulzentrum|8101912|XARTS
Rheinfelden(Baden)|8005064|RRH
Rheinsheim|8005067|RRHH
Rheinweiler|8005068|RRW
Rheinzabern Alte Römerstraße|8005072|RRZU
Rheinzabern Bf|8005069|RRZA
Rheinzabern Rappengasse|8005071|RRZM
Richen(b Eppingen)|8005077|RRIH
Ried im Innkreis|8100405|XARI
Riedau|8100407|OARI
Riederau|8005086|MRDU
Riedlingen|8005087|TRI
Riegel am Kaiserstuhl Ort|8007284|RROP
Riegel-Malterdingen|8005090|RRL
Riegel-Malterdingen (SWEG)|8007299|RRP
Riehen|8005091|RRIE
Riehen Niederholz|8005093|RRID
Rieneck|8005092|NRCK
Rietheim(Württ)|8005097|TRH
Rietz in Tirol|8101457|XARZ
Rimbach|8005098|RRIM
Ringsheim/Europa-Park|8005101|RRI
Rinklingen|8079059|RBTR
Rinnthal|8005103|RRIT
Rippberg|8005105|RRB
Roding|8005121|NROD
Rohr-Bad Hall|8100167|XARH
Rohr/Raab|8101454|OARRH
Rohrbach(Ilm)|8000256|MRBI
Rohrbach(Oberbay)|8005145|MROH
Rohrbach(Pfalz)|8005146|RRST
Rohrbach-Vorau|8100183|OARV
Rohrdorf(Oberbay)|8005148|MRDO
Rohrenfeld|8005149|MRFD
Roigheim|8005151|TRO
Rollhofen|8005154|NRON
Rommelshausen|8005157|TROM
Roppen|8101448|XARP
Rosenau(b Grafenau)|8005166|NRNU
Rosenbach bei Villach|8100083|XARB
Rosenberg(Baden)|8005168|TRBG
Rosenheim|8000320|MRO
Rosenheim Aicherpark|8005169|MRAI
Rosenheim Hochschule|8005173|MROS
Rosenheim Hochschule|8071453|MROSO
Rot am See|8005179|TRS
Rot-Malsch|8005181|RRM
Rotenbach(Enz)|8070277|TRY
Roth|8005185|NRO
Rothenburg ob der Tauber|8005190|NROT
Rothenbürg|8005189|NRBG
Rott(Inn)|8005194|MRT
Rottenacker|8005195|TRR
Rottenburg(Neckar)|8005197|TRT
Rottendorf|8005198|NRTD
Rottershausen|8005199|NRHN
Rottweil|8000322|TR
Rottweil Göllsdorf|8005200|TRG
Rottweil Neufra|8004280|TRNF
Rottweil Saline|8005202|TRSA
Roßberg|8005174|TROS
Roßtal|8005177|NRL
Roßtal Wegbrücke|8005178|NRW
Rudersberg|8007196|TRU
Rudersberg Nord|8070079|TRUN
Rudersberg-Oberndorf|8007625|TRUO
Ruhmannsfelden|8070664|NRUF
Ruhpolding|8005222|MRPD
Ruhstorf|8005223|MRUS
Rum b.Innsbruck|8100477|XARU
Runding|8005228|NRUD
Rupprechtstegen|8005231|NRST
Rutesheim|8005236|TRUT
Rödental|8004633|NRTL
Rödental Mitte|8005122|NRTM
Röhrmoos|8005127|MRMS
Röhrnbach|8070810|NRBH
Röslau|8005133|NROE
Röt|8005135|RRT
Rötenbach(Baden)|8005136|RROE
Röthenbach(Allgäu)|8005138|MRTA
Röthenbach(Oberpf)|8005139|NRTH
Röthenbach(Pegnitz)|8005140|NRP
Röthenbach-Seespitze|8005142|NRPE
Röthenbach-Steinberg|8005141|NRPG
Rückersdorf(Mfr)|8005209|NRUE
Rülzheim Bf|8005217|RRZH
Rülzheim Freizeitzentrum|8005214|RRZD
Rümmingen|8070524|RRMM
Rüsselbach|8005219|NRLB
Saal(Donau)|8005238|NSL
Saalfelden|8100049|XASA
Sachsen(b Ansbach)|8005250|NSA
Sachsenheim|8005253|TSA
Salach|8005258|TSAL
Salem|8004029|RSLM
Sallach|8005259|MSAL
Salzburg Aigen|8101470|XASBA
Salzburg Aiglhof|8102048|XAAI
Salzburg Gnigl|8100559|XASG
Salzburg Hbf|8100002|XASB
Salzburg Kasern|8101558|XASBK
Salzburg Liefering|8102063|XASLF
Salzburg Mülln-Altstadt|8102052|XAML
Salzburg Parsch|8101481|XASBP
Salzburg Sam|8102055|XASSA
Salzburg Süd|8101917|XASBS
Salzburg Taxham Europark|8102045|XATX
Sand(Niederbay)|8005279|NSND
Sasbach am Kaiserstuhl|8007287|RSAS
Satteldorf|8005297|TSAT
Sauerlach|8005299|MSR
Sauldorf|8077776|RSDO
Saulgrub|8005302|MSGB
Schaan-Vaduz|8100482|XASVZ
Schaftenau|8100483|XASFU
Schaftlach|8005311|MSFL
Schaidt(Pfalz)|8007857|RSAI
Schalchen|8005312|MSCA
Schalchen-Mattighofen|8102068|XASMH
Schalkstetten|8007072|TSKS
Schallstadt|8005317|RSAL
Scharnitz|8100088|XAA
Schechen|8005327|MSC
Schelklingen|8005333|TSK
Schemmerberg|8005334|TSX
Schenkenzell|8005335|RSZL
Scheppach|8005329|TSEP
Schierling|8070811|MSLG
Schifferstadt|8000326|RSD
Schifferstadt Süd|8005345|RSDS
Schiltach|8005350|RSCL
Schiltach Mitte|8005347|RSCM
Schirnding|8005352|NSG
Schladming|8100137|XASL
Schlatt(Hohenz)|8007222|TSLT
Schlechtbach|8007195|TSLB
Schliengen|8005364|RSG
Schliersee|8005367|MSCS
Schlins-Beschling|8101543|OASLN
Schloss Haus|8100585|OASH
Schluchsee|8005371|RSLU
Schlöglmühl|8100587|OASGM
Schlüßlberg|8100584|OASBG
Schmiechen|8005379|TSHM
Schmiechen Albbahn|8070974|TSHA
Schmiechen(Schwab)|8005381|MSCN
Schnabelwaid|8000328|NSAW
Schnaittach Markt|8005383|NSMA
Schneeberg im Odenwald|8005386|NSCB
Schnelldorf|8005388|NSNE
Schney|8005391|NSY
Schnitzmühle|8070670|NSNI
Schondorf(Bay)|8005417|MSDF
Schongau|8005418|MSGU
Schonungen|8005400|NSGN
Schopfheim|8005420|RSCH
Schopfheim West|8005425|RSCW
Schopfheim-Schlattholz|8005426|RSCS
Schopfloch(b Freudenstadt)|8005421|TSPF
Schorndorf|8005424|TSF
Schorndorf-Hammerschlag|8007191|TSFH
Schrezheim|8005431|TSCH
Schrobenhausen|8005432|MSHN
Schrozberg|8005433|TSZG
Schruns|8100117|XASN
Schwabach|8005439|NSC
Schwabach-Limbach|8005440|NSCL
Schwabhausen(b Dachau)|8005442|MSHH
Schwabmünchen|8005444|MSMN
Schwabsberg|8005445|TSWA
Schwaig|8005451|NSAI
Schwaigern Ost|8070156|TSWO
Schwaigern(Württ)|8005453|TSWG
Schwaigern(Württ) West|8071002|TSWW
Schwaikheim|8005454|TSWK
Schwandorf|8000027|NSCH
Schwanenstadt|8100016|OASST
Schwarzach i Vorarl.|8101634|OASWV
Schwarzach-St.Veit|8100044|XASW
Schwarzenau im Waldviertel|8100199|OASZ
Schwarzenbach(b Pressath)|8005465|NSW
Schwarzenbach(Saale)|8005466|NSBS
Schwarzenberg|8006715|RSW
Schwarzenfeld(Opf)|8005469|NSDO
Schwaz|8100103|XASC
Schwechat|8100259|XAGS
Schweighofen|8007860|RSHF
Schweinfurt Hbf|8000032|NS
Schweinfurt Mitte|8005479|NSMT
Schweinfurt Stadt|8005481|NSST
Schweinsdorf|8005485|NSWF
Schwenningen(Bay)|8005489|MSWN
Schwenningen(Neckar)|8005490|RSCV
Schwetzingen|8005494|RSZ
Schwetzingen Nordstadt|8005492|RSZD
Schwetzingen-Hirschacker|8005493|RHKR
Schwieberdingen|8007326|TSBD
Schwindegg|8005495|MSDG
Schwäbisch Gmünd|8000329|TSG
Schwäbisch Hall|8005449|TSHL
Schwäbisch Hall-Hessental|8000330|TSHT
Schwörstadt|8005497|RSST
Schärding|8100024|XASH
Schömberg Stausee|8072211|TSCS
Schömberg(b Balingen)|8029359|TSCB
Schönau bei Litschau Dorfwirt|8133912|PAKPF
Schönbichl, Vils (A)|8100557|XASBL
Schönfeld-Lassee|8101545|OASLS
Schöngeising|8005406|MSNG
Schönmünzach|8005409|RSOM
Schönwald(Oberfr)|8005412|NSOE
Schönwies|8101629|XASCH
Sebersdorf|8100179|OASB
Seckach|8000042|RSE
Seebrugg|8005502|RSEE
Seefeld in Tirol|8100113|XAS
Seefeld-Hechendorf|8005504|MSH
Seeg|8005505|MSEG
Seekirchen am Wallersee|8100426|XASK
Seekirchen/Wallersee Stadt|8110427|D8110427
Seeleiten-Berggeist|8005506|MSEB
Seeshaupt|8005508|MSE
Seiboldsdorf|8005512|MSBD
Selb Nord|8005516|NSN
Selb Stadt|8005517|NSS
Selb-Plößberg|8005518|NSP
Selbitz|8005520|NSLZ
Seligenstadt Mainschleifenbahn|8070859|NSLIM
Seligenstadt(b Würzburg)|8005523|NSLI
Selzthal|8100150|XASZ
Semmering|8100028|XASEM
Senden|8005532|MSED
Sennfeld|8005536|TSE
Sersheim|8005540|TSER
Seubersdorf|8005543|NSF
Seulbitz|8005545|NSE
Seybothenreuth|8005547|NSYB
Siebeldingen-Birkweiler|8005551|RSIB
Siebenbrunn-Leopoldsdorf|8101477|OASBL
Siegelsbach|8007438|RSGB
Siegelsdorf|8005557|NSDF
Siegsdorf|8005559|MSGD
Sierndorf an der March|8101524|OASIM
Siglingen|8005566|TSY
Sigmaringen|8000069|TSIG
Sigmaringendorf|8005568|TSID
Sigmundsherberg|8100493|OASHB
Sillian|8100142|XASIL
Silz im Oberinntal|8100586|XASLZ
Simbach(Inn)|8000072|MSBI
Simmelsdorf-Hüttenbach|8005572|NSHU
Sindelfingen|8005574|TSI
Singen Industriegebiet|8079616|RSII
Singen Landesgartenschau|8005560|RSIS
Singen(Hohentwiel)|8000073|RSI
Sinsheim Museum/Arena|8070097|RSMM
Sinsheim(Elsenz) Hbf|8005578|RSM
Sinzheim|8005587|RSZM
Sinzheim Nord|8005588|RSZN
Sinzing|8005581|NSIH
Sipplingen|8005582|RSIN
Solnhofen|8005593|MSO
Sondernach|8005601|TSOD
Sondernheim|8005602|RSOH
Sontheim(Schwab)|8005607|MSHM
Sontheim-Brenz|8005608|TSON
Sonthofen|8005609|MSF
Soyen|8005614|MSY
Spaichingen|8005616|TSP
Spaichingen Mitte|8005617|TSPM
Speikern|8005625|NSKN
Speyer Hbf|8005628|RSP
Speyer Nord-West|8005626|RSPN
Spiegelau|8005630|NSPU
Spielberg|8079048|RSPG
Spielfeld-Straß|8100082|XASS
Spital am Pyhrn|8100306|XASPP
Spittal-Millstätter See|8100092|XASP
St Alban|8005639|MSAB
St Georgen(Schwarzw)|8005644|RSGO
St Ilgen-Sandhausen|8005648|RSIG
St Koloman|8005652|MKL
St Mang|8005653|MMG
St Ottilien|8005656|MOTN
St. Andrä am Zicksee|8100431|OASAB
St. Anton am Arlberg|8100064|XAAB
St. Anton im Montafon|8100497|XAAM
St. Georgen/Gusen|8101501|OASGG
St. Georgen/Gusen Ort|8101502|OASGH
St. Johann im Pongau|8100043|XASJ
St. Johann in Tirol|8100054|XAJT
St. Paul im Lavanttal|8100501|XASPL
St. Valentin|8100009|XASV
St.Egyden am Steinfeld|8101489|OASED
St.Georgen/Mattig|8101506|XASGM
St.Jodok am Brenner|8101529|XAJO
St.Johann in der Haide|8100181|OASJ
St.Martin b.Weitra|8101562|OASMW
St.Michael in Obersteiermark|8100071|XASE
St.Peter-Seitenstetten|8101597|XASPS
St.Pölten Hbf|8100008|XAP
St.Veit/Glan|8100078|XAVG
Stadt Rottenmann|8100309|XASRM
Stadtprozelten|8005666|NSPO
Stahringen|8077773|RST
Stainach-Irdning|8100132|XASI
Stammbach|8005674|NSM
Stams|8100589|XASTM
Stans bei Schwaz|8100310|XASTS
Starnberg|8005676|MST
Starnberg Nord|8005675|MSNO
Staufen|8007332|RSTF
Staufen Süd|8007333|RSTS
Stegenwaldhaus|8005686|NSWH
Stein(Traun)|8005687|MSTN
Stein/Enns|8101494|OASEN
Steinach in Tirol|8100107|XAST
Steinach(Baden)|8005688|RSNA
Steinach(bei Rothenburg ob der Tauber)|8000091|NSTN
Steinbach am Wald|8005692|NSD
Steinbach-Bad Großpertholz|8101508|OASGP
Steindorf bei Straßwalchen|8100020|XASF
Steinebach|8005699|MSA
Steinen|8005701|RSTN
Steinfeld(Pfalz)|8007858|RSFL
Steinhöring|8005709|MSHG
Steinsfurt|8005714|RSS
Steinweiler|8005713|RSTE
Steinwiesen Bf|8005716|NSTW
Stetten (b. Haigerloch)|8070548|TSTT
Stetten am Heuchelberg|8005724|TSHG
Stetten(Donau)|8005723|TSTD
Stetten(Schwab)|8005725|MSTS
Stetten-Beinstein|8005726|TSTE
Stettfeld(Baden)|8007134|RSF
Stettfeld-Weiher|8005933|RSFW
Steyr|8100010|XASY
Steyregg|8101614|OASTY
Stillfried|8101536|OASLD
Stockach|8077774|RSTK
Stockau|8005734|NSOK
Stockdorf|8005735|MSD
Stockerau|8100534|XASRA
Stockheim(Oberfr)|8005737|NSTH
Stockheim(Unterfr)|8005738|NSTU
Storzingen|8005747|TSGZ
Strasshof|8101595|XASTH
Straubing|8000095|NST
Straubing Hafen|8006744|NSH
Straubing-Ost|8006745|NSTT
Straß-Moos|8005749|MSMS
Straßberg-Winterlingen|8005750|TSTR
Straßkirchen|8005752|NSK
Straßwalchen|8100019|XASR
Straßwalchen West|8102062|XASRW
Strullendorf|8005760|NSU
Stubersheim|8007071|TSBH
Studenzen-Fladnitz|8100196|OASU
Stuttgart Ebitzweg|8005766|TSEB
Stuttgart Feuersee|8006699|TSFS
Stuttgart Flughafen/Messe|8005768|TFL
Stuttgart Hbf|8000096|TS
Stuttgart Hbf (tief)|8098096|TS  T
Stuttgart Neckarpark|8006743|TSNS
Stuttgart Nordbahnhof|8005767|TSN
Stuttgart Nürnberger Str.|8004357|TSNU
Stuttgart Schwabstr.|8006698|TSS
Stuttgart Stadtmitte|8006700|TSMI
Stuttgart Universität|8006513|TSUN
Stuttgart-Bad Cannstatt|8005769|TSC
Stuttgart-Feuerbach|8005770|TSFE
Stuttgart-Münster|8005771|TSM
Stuttgart-Obertürkheim|8005772|TSOM
Stuttgart-Rohr|8005773|TSRO
Stuttgart-Sommerrain|8005774|TSSM
Stuttgart-Untertürkheim|8005775|TSU
Stuttgart-Vaihingen|8005776|TSV
Stuttgart-Zazenhausen|8005777|TSZAH
Stuttgart-Zuffenhausen|8005778|TSZ
Stuttgart-Österfeld|8005779|TSOS
Stühlingen|8005764|RSTU
Stühlingen-Eberfingen|8001625|RSEBE
Sulmingen|8079100|TSUM
Sulz(Neckar)|8005791|TSUL
Sulz-Röthis|8101585|OASR
Sulzbach(Inn)|8005793|MSBH
Sulzbach(Main)|8005794|NSUZ
Sulzbach(Murr)|8005795|TSBM
Sulzbach-Rosenberg|8005800|NSR
Sulzbach-Rosenberg Hütte|8005801|NSRH
Sulzberg|8005802|MSUG
Sulzfeld(Baden)|8005805|RSFD
Summerau|8100316|XASUM
Söchau|8100429|OASAU
Söllingen Kapellenstraße|8070865|RSLA
Söllingen Reetzstr.|8007866|RSLR
Söllingen(b Karlsr)|8005585|RSL
Sülzbach|8005786|TSUE
Sülzbach Schule|8005792|TSUS
Sünching|8005787|NSUE
Süßen|8005790|TSD
Tacherting|8005813|MTCH
Takern-St.Margarethen|8100318|OATSM
Tallesbrunn|8101644|OATAL
Tamm(Württ)|8005820|TTM
Tannheim(Württ)|8005823|TTA
Tapfheim|8005824|MTPF
Tassenbach|8101646|OATAS
Tauberbischofsheim|8005827|TTB
Tauberfeld|8005828|MTA
Tauchen-Schaueregg|8100187|OATS
Taufkirchen|8005831|MTU
Taufkirchen an der Pram|8100320|XATF
Taxenbach-Rauris|8100046|XATR
Tegernsee|8007632|MTE
Teichstätt|8101658|XATT
Teisendorf|8005833|MTO
Teisnach|8070666|NTEN
Teisnach Rohde+Schwarz|8005839|NTRS
Telfs-Pfaffenhofen|8100060|XATP
Teningen-Mundingen|8005836|RTMU
Tenneck|8101660|XATN
Terfens-Weer|8100323|XATW
Ternitz|8101661|OATER
Thal|8100324|OATHL
Thalfingen(b Ulm)|8005845|TTL
Thann-Matzbach|8005852|MTMA
Thansüß|8005855|NTAS
Thayngen|8005856|RTG
Thiergarten(Hohenz)|8007867|TTI
Thörl-Maglern|8101675|OATM
Thüngersheim|8005864|NTHM
Tiefenbach(b Passau)|8026544|NTFB
Tiengen(Hochrhein)|8005871|RTI
Timelkam|8101670|OATIM
Tisis (Feldkirch)|8101685|XATI
Titisee|8005876|RTIT
Tittmoning-Wiesmühl|8006422|MWSL
Trabitz|8005890|NTB
Trasadingen|8005892|RT
Traun OÖ|8101690|XATRN
Traundorf|8005893|MTRD
Traunreut|8005894|MTRT
Traunstein|8000116|MTS
Traunstein Klinikum|8005873|MTSK
Trebgast|8005895|NTG
Treibach-Althofen|8100096|XATA
Treuchtlingen|8000122|MTL
Triberg|8005902|RTR
Trieben|8100128|XAT
Triefenried|8005903|NTRI
Triesdorf|8005907|NTF
Trimmelkam|8100379|XATK
Trochtelfingen ALB-GOLD|8007147|TTRA
Trochtelfingen(b Bopfingen)|8005908|TTO
Trochtelfingen(Hohenz)|8070557|TTRF
Trossingen Bahnhof|8005911|TTR
Trossingen Stadt|8007646|TTRS
Trostberg|8005912|MTSB
Tschagguns|8100118|XATS
Tulling|8005924|MTUL
Tulln a.d.Donau|8100203|XATU
Tullnerfeld|8102059|XATD
Tuttlingen|8000163|TTU
Tuttlingen Gänsäcker|8005946|TTUG
Tuttlingen Nord|8000456|TTUN
Tuttlingen Schulen|8005925|TTUS
Tuttlingen Zentrum|8079056|TTUZ
Tutzing|8005927|MTZ
Töging(Inn)|8005883|MTG
Tübingen Hbf|8000141|TT
Tübingen West|8005916|TTW
Tübingen-Derendingen|8005917|TTD
Tübingen-Lustnau|8005918|TTLU
Türkenfeld|8005920|MTFD
Türkheim(Bay)Bf|8000144|MTHB
Tüßling|8005923|MTLG
Ubstadt Ort|8007133|RUO
Ubstadt Salzbrunnenstr|8085003|RUOS
Ubstadt Uhlandstr.|8070098|RUOU
Ubstadt-Weiher|8005931|RUW
Uffenheim|8005947|NU
Uffing a Staffelsee|8005948|MUF
Uhingen|8005949|TUH
Uhldingen-Mühlhofen|8004595|RUDM
Ulm Hbf|8000170|TU  P
Ulm Ost|8005952|TUO
Ulm-Donautal|8005954|TUDT
Ulm-Söflingen|8005955|TU  F
Ulmerfeld-Hausmening|8101695|XAUH
Ulrichsbrücke-Füssen|8100558|XAU
Umrathshausen Bf|8005961|MURB
Umrathshausen Ort|8005962|MURO
Unadingen|8005963|RUN
Undorf|8005966|NUDF
Unfriedsdorf|8005967|NUND
Unterammergau|8005975|MUAG
Unterasbach|8005976|NUA
Unteraschau|8005977|MUA
Unterberg-Stefansbrücke|8101712|XAUS
Unterelchingen|8005983|TUE
Unterföhring|8005986|MUFG
Untergimpern|8007436|RUG
Untergrainau|8017042|MUGR
Untergriesheim|8005989|TUG
Untergrombach|8005990|RURB
Unterhaching|8005991|MUH
Unterharmersbach|8007103|RUH
Unterhausen(Bay)|8005993|MUHN
Unterheckenhofen|8005995|NUT
Unterjesingen Mitte|8006002|TUJM
Unterjesingen Sandäcker|8006003|TUJS
Unterkochen|8005997|TUK
Unterlenningen|8005998|TUL
Unterreichenbach|8006008|TURB
Unterretzbach|8102056|PASWS
Unterschleißheim|8006688|MUSM
Unterschwaningen|8071104|MUSG
Untersteinach(b Stadtsteinach)|8006017|NUS
Untersteinach(Bayr)|8006016|NUST
Unterwurmbach|8006025|MUWB
Unteröwisheim Bf|8007140|RUOE
Unteröwisheim M.-Luther-Str.|8079149|RUOEL
Unzmarkt|8100074|XAUM
Urbach(b Schorndorf)|8006030|TUA
Urschalling|8006037|MURS
Urspring|8006039|TURS
Uttendorf-Helpfau|8100333|XAUDH
Utting|8006048|MUTG
Vach|8006052|NVA
Vachendorf|8006717|MVAD
Vaihingen(Enz)|8006053|TV
Vaihingen(Enz)Nord|8007660|TVN
Vandans|8100380|XAVA
Vaterstetten|8006059|MVS
Veitshöchheim|8006065|NVE
Velden am Wörther See|8100081|XAVE
Velden(b Hersbruck)|8006067|NVN
Veringendorf|8007233|TVRD
Veringenstadt|8007232|TVRS
Viechtach|8070561|NVIC
Vierkirchen-Esterhofen|8001922|MESH
Villach Hbf|8100147|XAVH
Villach Warmbad|8100382|XAWV
Villach Westbf|8100148|XAVW
Villingen(Schwarzw)|8000366|RVL
Villingen-Schwenningen Eisstadion|8000356|RVLE
Villingen-Schwenningen Hammerstatt|8000393|RVLH
Vils in Tirol|8100116|XAV
Vils Stadt|8102260|XAVIS
Vilsbiburg|8006084|MVSB
Vilseck|8006085|NVK
Vilshofen(Niederbay)|8006086|NVI
Vitis|8100335|OAVT
Vohburg-Rockolding|8006101|MVG
Volders-Baumkirchen|8100337|XAVO
Volkach-Astheim|8070860|NVOLA
Vorra(Pegnitz)|8006120|NV
Vöcklabruck|8100507|XAVB
Vöcklamarkt|8100508|XAVM
Vöhringen|8006094|MVRN
Völs|8101728|XAVL
Wachenheim(Pfalz)|8006125|RWCH
Wackershofen|8006135|TWHF
Waffenbrunn|8006134|NWAF
Waghäusel|8006137|RWG
Waging|8006138|MWGN
Wahlwies|8077775|RWW
Waiblingen|8000180|TWN
Waibstadt|8007442|RWB
Waigolshausen|8006147|NWA
Wald am Schoberpass|8100127|XAWA
Waldenburg(Württ)|8006154|TWG
Waldershof|8006155|NWDH
Waldhausen(b Geislingen)|8007073|TWHS
Waldhausen(b Schorndorf)|8006157|TWY
Waldkirch|8006159|RWA
Waldkirchen(Niederbay.)|8006160|NWKN
Waldkraiburg-Kraiburg|8006164|MWKG
Waldmünchen|8006163|NWLM
Waldshut|8006167|RWU
Walheim(Württ)|8006171|TWH
Walldürn|8006176|RWDN
Wallern im Burgenland|8100341|OAWAN
Wallersdorf|8006181|NWLD
Wallersee|8101803|XAWAL
Walleshausen|8006184|MWHN
Wallhausen(Württ)|8006145|TWAL
Walpertskirchen|8006190|MWKN
Wangen(Allgäu)|8006200|TWW
Wannweil|8006203|TWAN
Warngau|8006210|MWGU
Wartberg im Mürztal|8100383|XAWB
Wartberg/Krems|8101742|XAWBK
Warthausen|8006212|TWV
Wasenweiler|8006215|RWR
Wasseralfingen|8006217|TWA
Wasserburg(Bodensee)|8006218|MWBG
Wasserburg(Günz)|8006219|MWSG
Wasserburg(Inn)Bf|8006220|MWSB
Wassertrüdingen|8070567|MWTD
Wasserzell(b Eichstätt)|8006224|MWAS
Watzelsteg|8007341|NWAS
Wehr-Brennet|8001174|RBN
Weibhausen|8006255|MWBH
Weichering|8006256|MWEI
Weickersgrüben|8006257|NWGR
Weiden am See|8100343|OAWAS
Weiden(Oberpf)|8000204|NWDO
Weidenbach|8006258|MWDB
Weidenberg|8006259|NWBE
Weidenthal|8006261|RWD
Weiding|8006264|NWDG
Weiherhammer|8006266|NWHR
Weiherhof|8006267|NWHF
Weikendorf-Dörfles|8101748|OAWDL
Weikersheim|8006269|TWM
Weil am Rhein|8006272|RW
Weil am Rhein Ost|8006273|RWEI
Weil am Rhein-Gartenstadt|8000143|RWGA
Weil am Rhein-Pfädlistraße|8000146|RWPF
Weil der Stadt|8006271|TW
Weil im Schönbuch Röte|8085013|TWEI
Weil im Schönbuch Troppel|8085012|TWEIT
Weil im Schönbuch Untere Halde|8085014|TWEIU
Weilbach(Unterallg)|8006279|MWLB
Weilbach(Unterfr)|8006274|NWE
Weiler(Rems)|8006277|TWEL
Weilheim(Oberbay)|8000220|MWH
Weilheim(Württ)|8006281|TWLH
Weilimdorf|8006268|TSWF
Weingarten Berg|8087067|TWEB
Weingarten(Baden)|8006287|RWGT
Weinheim(Bergstr)Hbf|8000377|RWE
Weinheim-Lützelsachsen|8003792|RLUE
Weinheim-Sulzbach|8006283|RWEZ
Weinsberg|8006289|TWR
Weinsberg West|8006290|TWRW
Weinsberg/Ellhofen Gewerbegebiet|8006294|TELI
Weisenbach|8006291|RWSB
Weisenheim(Sand)|8006292|RWSS
Weitlanbrunn|8101784|OAWLB
Weitra|8101808|OAWTR
Weizen|8070569|RWZ
Weizern-Hopferau|8006309|MWZH
Weißenau|8006296|TWSN
Weißenburg(Bay)|8006298|NWG
Weißenhorn|8006299|MWSH
Weißenhorn-Eschach|8006305|MAES
Weißenohe|8006300|NWEO
Wels Hbf|8100014|XAWE
Welschingen-Neuhausen|8006321|RWEL
Wendling b.Haag|8101785|XAWEN
Wendlingen(Neckar)|8006331|TWD
Wennedach|8079101|TWEN
Werfen|8100539|XAWRF
Wernau(Neckar)|8006346|TWER
Wernberg|8006347|NWRB
Wernfeld|8006349|NWFH
Wernstein|8100544|XAWR
Wertach-Haslach|8006353|MWHA
Wertheim|8000231|TWT
Wertheim-Bestenheid|8006354|TWTB
Westendorf|8006363|MWDF
Westendorf in Tirol|8100058|XAWD
Westerham|8006366|MWM
Westerstetten|8006373|TWSH
Westhausen|8006376|TWX
Westheim(Schwab)|8006378|MWHS
Westheim-Langendorf|8006380|NWL
Weststeiermark|8101345|XAWES
Weßling(Oberbay)|8006359|MWS
Wicklesgreuth|8006390|NWK
Wien Aspern Nord|8102888|PAWAN
Wien Floridsdorf|8100236|XAWFL
Wien Franz-Josefs-Bahnhof|8100446|XAWF
Wien Grillgasse|8101556|OASMN
Wien Handelskai (Bahnsteige 1-2)|8101934|OAHAN
Wien Hbf|8103000|XAWIE
Wien Hbf (Autoreisezuganlage)|8100004|XAWIO
Wien Hbf (Bahnsteige 1-2)|8101590|OASRP
Wien Heiligenstadt|8100269|OAHE
Wien Hernals|8100271|XAHN
Wien Hütteldorf|8100447|XAWH
Wien Jedlersdorf|8101013|XAJD
Wien Kaiserebersdorf|8100374|XAKS
Wien Leopoldau|8101170|OALOP
Wien Liesing|8101150|OALIE
Wien Matzleinsdorfer Platz|8101227|OAMLP
Wien Meidling|8100514|XAWG
Wien Mitte|8100449|XAWMI
Wien Penzing|8100450|XAWP
Wien Praterstern|8100349|XAWNP
Wien Quartier Belvedere|8101473|OASBF
Wien Rennweg|8101433|OAREN
Wien Siemensstraße|8100796|OAFLO
Wien Simmering|8101553|XAWSG
Wien Spittelau|8101937|OASPL
Wien Stadlau|8104229|XASU
Wien Süßenbrunn|8101619|XASBN
Wien Traisengasse|8101641|OATAG
Wien Westbahnhof|8100003|XAWW
Wiener Neustadt Hbf|8100516|XAWNS
Wiesau(Oberpf)|8006403|NWU
Wiesenfeld(b Coburg)|8006414|NWDC
Wiesental|8006417|RWI
Wiesenthau|8006418|NWIE
Wieslensdorf|8006416|TWID
Wiesloch-Walldorf|8006421|RWS
Wiesmühl(Alz)|8006423|MWSM
Wiesthal|8006426|NWI
Wilburgstetten Bf|8070620|MWBN
Wilchingen-Hallau|8006430|RWIN
Wildberg(Württ)|8006432|TWIB
Wildon|8101774|XAWI
Wilferdingen-Singen|8006440|TWL
Wilgartswiesen|8006441|RWSW
Wilhermsdorf|8006448|NWHD
Wilhermsdorf Mitte|8007856|NWDM
Willmering|8006455|NWIG
Willsbach|8006456|TWLB
Windau im Brixental|8101776|OAWIN
Winden(Pfalz)|8006468|RWND
Windischeschenbach|8006472|NWB
Windischgarsten|8100517|XAWIG
Windsbach|8006473|NWIN
Winkelhaid|8006476|NWKH
Winnenden|8006479|TWI
Winterbach(b Schorndorf)|8006485|TWIN
Winterhausen|8006488|NWN
Wittighausen|8006517|TWIT
Wittlingen|8070578|RWL
Witzighausen|8006493|MWIT
Wolfach|8006544|RWO
Wolfegg|8006545|TWO
Wolfratshausen|8006550|MWO
Wolfsmünster|8006554|NWM
Wolfurt|8100389|XAWT
Wolkersdorf im Weinviertel|8101793|XAWO
Wollbach(Baden)|8070579|RWBB
Wulkaprodersdorf|8100361|OAWPF
Wullenstetten|8006595|MWUH
Wunsiedel-Holenbrunn|8000173|NHOB
Wurlitz|8006624|NWLZ
Wurmlingen Mitte|8006625|TWUM
Wurmlingen Nord|8006626|TWUN
Wutöschingen|8006628|RWUT
Wyhlen|8006629|RWY
Wächterhof|8006131|MWAE
Wörgl Hbf|8100099|XAWL
Wörgl Süd-Bruckhäusl|8101571|OASOL
Wörnitzstein|8006533|MWNS
Wörschach Schwefelbad|8100425|OASBW
Wörth(Isar)|8006537|MWTI
Wörth(Main)|8006538|NWOE
Wörth(Rhein)|8000254|RWRT
Wörth(Rhein) Alte Bahnmeisterei|8079143|RWRTL
Wörth(Rhein) Badallee|8079212|RWRTA
Wörth(Rhein) Badepark|8079213|RWRTK
Wörth(Rhein) Bienwaldhalle|8079142|RWRTB
Wörth(Rhein) Bürgerpark|8079141|RWRTP
Wörth(Rhein) Mozartstraße|8006536|RWRD
Wörth(Rhein) Rathaus|8079211|RWRTR
Wörth(Rhein) Zügelstraße|8006531|RWRZ
Wössingen|8006539|RWSN
Wössingen Ost|8070179|RWSO
Würzburg Hbf|8000260|NWH
Würzburg Süd|8006582|NWS
Würzburg-Heidingsfeld Ost|8006580|NWHO
Würzburg-Zell|8006586|NWZ
Wüstenselbitz|8006588|NWBZ
Ybbs a.d. Donau|8100007|XAY
Zainhammer|8006632|NZH
Zaisenhausen|8006633|RZA
Zapfendorf|8006634|NZA
Zeil|8006635|NZ
Zell am See|8100048|XAZ
Zell am Ziller|8100547|XAZZ
Zell(Harmersbach)|8007101|RZLH
Zell(Wiesental)|8006641|RZ
Zell/Pram|8101819|OAZEL
Zellerndorf|8100363|OAZLD
Zellerthal|8007338|NZLT
Zeltweg|8100518|XAZW
Zeutern Bf|8007135|RZE
Zeutern Ost|8007136|RZEO
Zeutern Sportplatz|8079617|RZES
Ziersdorf|8101822|OAZIE
Zillendorf|8006660|NZF
Zimmern(b Seckach)|8006661|RZIM
Zimmern(Main-Tauber)|8006662|TZI
Zirl|8100451|XAZL
Zirndorf|8006664|NZI
Zirndorf Kneippallee|8006666|NZIK
Zollhaus(Villingen-Schwenningen)|8006667|RVLZ
Zollhaus-Petersthal|8006670|MZHP
Zorneding|8006671|MZO
Zotzenbach|8006672|RZT
Zurndorf|8101829|OAZU
Zusenhofen|8006678|RZHN
Zuzenhausen|8006679|RZUN
Zwiesel(Bay)|8006684|NZWL
Zwieselau|8006685|NZWU
Zwingenberg(Baden)|8006686|RZW
Züttlingen|8006676|TZU
Äpfingen|8079092|TAPF
Öblarn|8100133|OAOE
Öhringen Hbf|8004623|TOE
Öhringen West|8004624|TOEW
Öhringen-Cappel|8004620|TCP
Ölbronn-Dürrn|8004632|TOED
Ötigheim|8004636|ROH
Ötisheim|8004637|TOET
Ötztal|8100061|XAOE
Überlingen|8005942|RUEM
Überlingen Therme|8005937|RUEB
Überlingen-Nußdorf|8005943|RUEN
Übersbach b.Fürstenfeld|8101694|OAUB
Übersee|8005940|MUS`;
