// Проксі до сервісів розкладу поїздів.
// Джерело 1: v6.db.transport.rest (дані Deutsche Bahn, як у DB Navigator).
// Джерело 2: api.transitous.org (MOTIS, відкриті дані GTFS).
// Обидва безкоштовні, без ключів. Запити йдуть із сервера Vercel.
//
// Обидва джерела опитуються ОДНОЧАСНО (не по черзі), і результати
// ОБ'ЄДНУЮТЬСЯ: унікальні рейси з обох списків складаються разом і
// сортуються за часом. Так список повніший, ніж з одного джерела, а
// час очікування обмежений найповільнішим окремим запитом, а не сумою.

const DBREST = "https://v6.db.transport.rest";
const TRANSITOUS = "https://api.transitous.org";
// Коротші таймаути: якщо джерело не відповіло за цей час, воно майже
// напевно не відповість корисно й далі — краще віддати те, що вже є.
const DBREST_TIMEOUT_MS = 6000;
const TRANSITOUS_TIMEOUT_MS = 6000;

async function getJson(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      // User-Agent з посиланням на проєкт — так радить документація
      // db-vendo-client, це знижує шанс потрапити під троттлінг.
      headers: { Accept: "application/json", "User-Agent": "autdoor-actyvni.vercel.app (community trips app)" },
    });
    if (r.status === 429) throw new Error("HTTP 429 (rate limit)");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Обгортка над одним джерелом: ніколи не кидає помилку, а повертає
// однаковий за формою результат — так зручніше порівнювати джерела.
function probe(name, promise) {
  return promise.then(
    (items) => ({ name, ok: true, items: items || [] }),
    (err) => ({ name, ok: false, items: [], err: (err && err.message) || String(err) })
  );
}

// Повертає ПЕРШЕ джерело, яке дало непорожній результат, не чекаючи на
// решту. Якщо жодне нічого не дало — null. Саме цього бракувало пошуку
// станцій: там джерела опитувались по черзі, тож поки перше мовчало до
// свого таймауту, друге навіть не стартувало.
function firstUseful(probes) {
  return new Promise((resolve) => {
    let pending = probes.length;
    probes.forEach((p) => p.then((r) => {
      if (r.ok && r.items.length > 0) resolve(r);
      else if (--pending === 0) resolve(null);
    }));
  });
}

// Запускає всі джерела ОДНОЧАСНО й чекає, поки кожне або дасть відповідь,
// або впаде за власним таймаутом. Загальний час — це час найповільнішого
// окремого запиту, а не сума послідовних спроб.
async function fetchAll(sources) {
  const settled = await Promise.allSettled(sources.map(([, fn]) => fn()));
  return settled.map((s, i) => ({
    name: sources[i][0],
    ok: s.status === "fulfilled",
    data: s.status === "fulfilled" ? s.value : null,
    err: s.status === "rejected" ? s.reason : null,
  }));
}

// ── Пошук станцій ─────────────────────────────────────────────────────
async function locationsDbRest(query) {
  const p = new URLSearchParams({ query, results: "8", addresses: "false", poi: "false" });
  const j = await getJson(`${DBREST}/locations?${p}`, DBREST_TIMEOUT_MS);
  const items = (j || [])
    .filter((x) => x && x.id && x.name)
    .map((x) => ({ id: String(x.id), name: x.name }));
  const relevant = items.filter((x) => relevantToQuery(x.name, query));
  return relevant.length > 0 ? relevant : items;
}
// Запасний геокодер часом підмішує готелі, офіси тощо поруч зі станціями.
const NON_STATION_HINT = /\b(ibis|hotel|motel|hostel|mercure|novotel|nh\b|leonardo|kundencenter|reisezentrum|parkhaus|parking|gmbh|apotheke|restaurant|café|cafe)\b/i;
function looksLikeStation(name) {
  return !NON_STATION_HINT.test(name);
}
// Головне слово запиту (зазвичай назва міста) має бути присутнє в назві
// станції — без цього трапляються зовсім чужі міста (шукаємо "Augsburg",
// а деякі геокодери повертають "Ulm Hauptbahnhof" лише тому, що обидва
// містять слово "Hauptbahnhof").
function relevantToQuery(name, query) {
  const mainWord = String(query).toLowerCase().trim().split(/\s+/)[0];
  if (!mainWord || mainWord.length < 3) return true;
  return name.toLowerCase().includes(mainWord);
}
// "Hbf" і "Hauptbahnhof" — це ОДНА й та сама станція під різними назвами.
// Нормалізуємо перед порівнянням, інакше дублюються в списку.
function normalizeStationKey(name) {
  return name
    .toLowerCase()
    .replace(/\bhbf\b/g, "hauptbahnhof")
    .replace(/\bbf\b/g, "bahnhof")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
async function locationsTransitous(query) {
  const p = new URLSearchParams({ text: query, language: "de" });
  const j = await getJson(`${TRANSITOUS}/api/v1/geocode?${p}`, TRANSITOUS_TIMEOUT_MS);
  const arr = Array.isArray(j) ? j : (j && j.results) || [];
  const items = arr
    .filter((x) => x && (x.id || x.stopId) && x.name)
    .map((x) => ({ id: "T:" + String(x.id || x.stopId), name: x.name }));
  const clean = items.filter((x) => looksLikeStation(x.name) && relevantToQuery(x.name, query));
  return (clean.length > 0 ? clean : items).slice(0, 8);
}
function mergeLocations(lists) {
  // Дедуплікуємо за нормалізованим ключем (Hbf ≡ Hauptbahnhof), а не за
  // сирим текстом — інакше та сама станція з'являється двічі під різними
  // назвами з різних джерел.
  const seen = new Map();
  for (const list of lists) {
    for (const x of list) {
      const key = normalizeStationKey(x.name);
      if (!seen.has(key)) seen.set(key, x);
    }
  }
  return [...seen.values()].slice(0, 8);
}

// ── Пошук рейсів ──────────────────────────────────────────────────────
async function journeysDbRest(from, to, departure) {
  // Свідомо НЕ обмежуємо типи транспорту на боці HAFAS: якщо попросити
  // систему шукати одразу «тільки регіональні», вона часто повертає МЕНШЕ
  // варіантів — маршрутизатор не бачить проміжних комбінацій. Натомість
  // просимо повний пошук без обмежень і фільтруємо далекобійні поїзди вже
  // тут, на готовому списку (isRegionalJourney нижче).
  const p = new URLSearchParams({ from, to, results: "20", stopovers: "false" });
  if (departure) p.set("departure", departure);
  const j = await getJson(`${DBREST}/journeys?${p}`, DBREST_TIMEOUT_MS);
  return (j && j.journeys) || [];
}

const iso = (v) => (v ? String(v) : null);

// Далекобійні поїзди (за назвою).
const LONG_DISTANCE = /^(ICE|IC|EC|ECE|RJX|RJ|TGV|FLX|NJ|EN|THA|WB)\b/i;
// ВАЖЛИВО: список того, що ТОЧНО виключаємо (метро, трамваї, пороми,
// таксі, далекобійні) — а не список того, що дозволяємо. Якщо назва
// поля від сервісу не збігається з жодним відомим значенням, поїздку
// пропускаємо, а не відкидаємо. Це навмисно: одна помилка в назві поля
// не повинна тихо ховати всі регіональні поїзди DB — це вже траплялось.
const BLOCKED_PRODUCTS = new Set(["nationalexpress", "national", "subway", "tram", "ferry", "taxi"]);
// Додано HIGHSPEED_RAIL / LONG_DISTANCE / NIGHT_RAIL: раніше далекобійні
// поїзди відсіювались ЛИШЕ за назвою (ICE, IC, EC...), а у відкритих даних
// назвою буває голий номер лінії DB — «11», «42». Такий рейс проходив
// фільтр і потрапляв у список як «регіональний», хоча Deutschland-Ticket
// на нього не діє. Тепер вид транспорту перевіряється незалежно від назви.
const BLOCKED_GTFS_MODES = new Set(["SUBWAY", "TRAM", "FERRY", "CABLE_TRAM", "FUNICULAR", "MONORAIL", "AIRPLANE", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"]);
// Види транспорту, на які Deutschland-Ticket не діє. Це найнадійніша
// ознака: сервіс повідомляє її окремим полем, і вона не залежить від
// того, як перевізник назвав маршрут у своєму фіді.
const LD_MODES = new Set(["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "AIRPLANE"]);
function isRegionalJourney(jr) {
  return (jr.legs || []).every((l) => {
    if (l.walking) return true;
    // Готова ознака, порахована при розборі відповіді з сирих полів.
    // Так фільтр більше не залежить від тексту на бейджі: раніше це було
    // одне й те саме поле, і зміна оформлення напису мовчки змінювала
    // склад списку.
    if (l.longDistance === true) return false;
    if (l.longDistance === false) return true;
    const product = l.line && l.line.product ? String(l.line.product).toLowerCase() : null;
    if (product && BLOCKED_PRODUCTS.has(product)) return false;
    const mode = l.mode ? String(l.mode).toUpperCase() : null;
    if (mode && BLOCKED_GTFS_MODES.has(mode)) return false;
    const name = (l.line && l.line.name) || "";
    if (LONG_DISTANCE.test(String(name).trim())) return false;
    return true;
  });
}
const delaySec = (actual, planned) => {
  if (!actual || !planned) return 0;
  const d = (new Date(actual) - new Date(planned)) / 1000;
  return isNaN(d) ? 0 : d;
};

// Позначка лінії. У фідах відкритих даних `routeShortName` — це сирий
// route_short_name із GTFS, і для німецьких регіональних перевізників він
// часто буває голим номером маршруту («11», «42»), який пасажирові нічого
// не каже. MOTIS спеціально віддає для показу окреме поле `displayName`
// (зʼявилось у версії API v4) — саме його треба брати першим. Раніше воно
// стояло третім у черзі й тому не використовувалось майже ніколи.
const MODE_TAG = {
  BUS: "Bus", COACH: "Bus", TRAM: "Tram", SUBWAY: "U", METRO: "U",
  SUBURBAN: "S", RAIL: "Zug", REGIONAL_RAIL: "Zug", REGIONAL_FAST_RAIL: "Zug",
  HIGHSPEED_RAIL: "Zug", LONG_DISTANCE: "Zug", NIGHT_RAIL: "Zug",
  FERRY: "Fähre", FUNICULAR: "Bahn", AERIAL_LIFT: "Bahn",
};
function lineLabel(l) {
  const first = [l.displayName, l.routeShortName, l.tripShortName, l.routeLongName]
    .map((x) => (x == null ? "" : String(x).trim()))
    .find((x) => x !== "");
  // MOTIS дописує до назви службовий номер рейсу — «RE89 (57037)».
  // Для табло він зайвий: на бейджі має бути видно лінію, а не номер
  // конкретного потяга.
  const name = (first || "").replace(/\s*\(\d+\)\s*$/, "").trim();
  // Уже містить літери (RB55, S8, RE9) — це готова позначка, не чіпаємо.
  if (/[A-Za-z]/.test(name)) return name;
  const tag = MODE_TAG[String(l.mode || "").toUpperCase()];
  if (name && tag) return `${tag} ${name}`;
  return name || tag || "";
}

// Номер колії. Беремо реальний (`track`, оновлюється даними реального
// часу), інакше плановий із розкладу. Пропускаємо через перевірку на
// правдоподібність: німецька колія — це число, іноді з літерою. Усе
// довше й химерніше майже напевно сміття у фіді, і краще не показати
// нічого, ніж показати хибний номер.
function cleanTrack(place) {
  const raw = (place && (place.track || place.scheduledTrack)) || "";
  const v = String(raw)
    .replace(/^(Gleis|Gl\.?|Bahnsteig|Bstg\.?|Platform|Plattform|Pl\.?|Track)\s*/i, "")
    .trim();
  if (!v) return null;
  return /^\d{1,3}[A-Za-z]?$/.test(v) || /^[A-Za-z]$/.test(v) ? v : null;
}

// Приводимо відповідь Transitous до вигляду DB, щоб застосунок не
// помічав різниці між джерелами.
// Види транспорту, які має сенс просити в режимі «лише регіональні».
// Це рівно те, що переживає фільтр isRegionalJourney нижче: далекобійні
// поїзди, метро, трамваї й пороми там усе одно відкидаються.
// Перелік МУСИТЬ збігатися з тим, що пропускає isRegionalJourney нижче.
// Якщо тут якогось виду транспорту бракує, маршрутизатор просто не зможе
// його використати — і варіантів у списку стане менше без жодної помилки.
// Саме так і сталося: бракувало REGIONAL_FAST_RAIL (це швидкі RE) та
// OTHER (усе, що перевізник не типізував), тож частина рейсів ставала
// для пошуку невидимою.
const REGIONAL_TRANSIT_MODES = "REGIONAL_RAIL,REGIONAL_FAST_RAIL,SUBURBAN,BUS,COACH,OTHER";

async function journeysTransitous(from, to, departure, regionalOnly, allModes) {
  const p = new URLSearchParams({
    fromPlace: String(from).replace(/^T:/, ""),
    toPlace: String(to).replace(/^T:/, ""),
    // Скільки варіантів просити. Застосунок показує їх по десять із
    // кнопкою «Показати ще», тож більший запас тут дає повніший розклад,
    // а не просто довшу стрічку.
    numItineraries: regionalOnly ? "30" : "20",
  });
  // КЛЮЧОВЕ: обмеження задаємо В ЗАПИТІ, а не відсіюємо готовий список.
  // Сервіс віддає фіксовану кількість варіантів; якщо їх зайняли ICE та
  // IC, після відсіювання лишаються одиниці. Саме через це список
  // ставав коротким. Просимо одразу потрібні види транспорту — і всі
  // отримані варіанти виявляються придатними.
  if (regionalOnly && !allModes) p.set("transitModes", REGIONAL_TRANSIT_MODES);
  if (departure) p.set("time", new Date(departure).toISOString());
  // Режим «розклад»: віддає рейси підряд у вікні часу. Вікно звужене до
  // 3 годин — Transitous тепер лише запасне джерело, тож не потребує
  // такого широкого пошуку, і відповідає швидше.
  p.set("timetableView", "true");
  // Ширше вікно, коли шукаємо лише регіональні: без далекобійних поїздів
  // рейсів у ту саму годину менше, тож за 3 години їх набирається замало.
  // Вікно на цілий робочий день, а не на кілька годин: людина планує
  // поїздку заздалегідь і хоче бачити весь розклад, а не найближчі рейси.
  p.set("searchWindow", "57600");
  // Дозволяємо пішохідні пересадки між вокзалами — без цього губляться
  // варіанти на кшталт «поїзд + 5 хв пішки + інший поїзд».
  p.set("maxPreTransitTime", "900");
  p.set("maxPostTransitTime", "900");
  const j = await getJson(`${TRANSITOUS}/api/v6/plan?${p}`, TRANSITOUS_TIMEOUT_MS);
  const its = (j && (j.itineraries || (j.plan && j.plan.itineraries))) || [];
  return its.map((it) => ({
    legs: (it.legs || []).map((l) => {
      const walking = String(l.mode || "").toUpperCase() === "WALK";
      const f = l.from || {}, tt = l.to || {};
      const depPlanned = iso(l.scheduledStartTime || f.scheduledDeparture || l.startTime);
      const depActual = iso(l.startTime || f.departure);
      const arrPlanned = iso(l.scheduledEndTime || tt.scheduledArrival || l.endTime);
      const arrActual = iso(l.endTime || tt.arrival);
      // Колії показуємо, але чесно позначаємо їхнє походження: підтверджені
      // даними реального часу вважаємо надійними, взяті лише з розкладу —
      // ні. Застосунок показує другі приглушено й додає застереження.
      // Раніше вони не показувались узагалі через випадки хибних номерів.
      const depTrack = walking ? null : cleanTrack(f);
      const arrTrack = walking ? null : cleanTrack(tt);
      const modeUp = String(l.mode || "").toUpperCase();
      const rawNames = [l.routeShortName, l.displayName, l.routeLongName]
        .map((x) => String(x == null ? "" : x).trim())
        .filter((x) => x !== "");
      return {
        walking,
        // Рахуємо тут, де доступні всі сирі поля від сервісу.
        longDistance: !walking && (LD_MODES.has(modeUp) || rawNames.some((n) => LONG_DISTANCE.test(n))),
        cancelled: Boolean(l.cancelled),
        origin: { name: f.name || "" },
        destination: { name: tt.name || "" },
        departure: depActual,
        plannedDeparture: depPlanned,
        departureDelay: delaySec(depActual, depPlanned),
        departurePlatform: depTrack,
        plannedDeparturePlatform: depTrack,
        platformTrusted: Boolean(l.realTime),
        arrival: arrActual,
        plannedArrival: arrPlanned,
        arrivalDelay: delaySec(arrActual, arrPlanned),
        arrivalPlatform: arrTrack,
        mode: l.mode || null,
        line: { name: lineLabel(l) },
      };
    }),
  }));
}

// Ключ для порівняння рейсів між джерелами: реальний момент часу
// (з точністю до хвилини), а не сирий текст. Джерела форматують час
// по-різному (одне зі зсувом +02:00, інше в UTC) — порівняння лише
// рядків пропускало б однакові поїзди як різні.
function journeyKey(jr) {
  const ls = (jr.legs || []).filter((l) => !l.walking);
  if (ls.length === 0) return null;
  const dep = ls[0].plannedDeparture || ls[0].departure;
  const arr = ls[ls.length - 1].plannedArrival || ls[ls.length - 1].arrival;
  const depMs = dep ? Math.round(new Date(dep).getTime() / 60000) : null;
  const arrMs = arr ? Math.round(new Date(arr).getTime() / 60000) : null;
  if (depMs == null || isNaN(depMs) || arrMs == null || isNaN(arrMs)) return null;
  return depMs + "|" + arrMs;
}
function mergeJourneys(lists) {
  const seen = new Map();
  let anon = 0;
  for (const list of lists) {
    for (const jr of list) {
      // Якщо для рейсу не вдалось побудувати ключ порівняння — не
      // викидаємо його мовчки, а лишаємо під унікальним технічним ключем.
      const k = journeyKey(jr) || ("anon:" + anon++);
      if (!seen.has(k)) seen.set(k, jr);
    }
  }
  const merged = [...seen.values()];
  merged.sort((a, b) => {
    const ga = (a.legs || []).find((l) => !l.walking);
    const gb = (b.legs || []).find((l) => !l.walking);
    const ta = ga ? new Date(ga.plannedDeparture || ga.departure).getTime() : 0;
    const tb = gb ? new Date(gb.plannedDeparture || gb.departure).getTime() : 0;
    return ta - tb;
  });
  return merged;
}

// Сирий (без розбору) запит до Transitous — лише для діагностики: щоб
// побачити РЕАЛЬНУ форму відповіді MOTIS, а не вже оброблену нами.
async function rawJourneysTransitous(from, to, departure) {
  const p = new URLSearchParams({
    fromPlace: String(from).replace(/^T:/, ""),
    toPlace: String(to).replace(/^T:/, ""),
    numItineraries: "10",
    timetableView: "true",
    searchWindow: "21600",
  });
  if (departure) p.set("time", new Date(departure).toISOString());
  return getJson(`${TRANSITOUS}/api/v6/plan?${p}`, TRANSITOUS_TIMEOUT_MS);
}

export default async function handler(req, res) {
  const { path, query, from, to, departure } = req.query || {};
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=180, stale-while-revalidate=900");

  try {
    if (path === "/locations") {
      if (!query) { res.status(400).json({ error: "no query" }); return; }
      // ОБИДВА джерела стартують одночасно, і відповідає те, яке першим
      // дало непорожній список. Раніше вони йшли по черзі: поки офіційне
      // мовчало до свого таймауту, запасне навіть не починало працювати —
      // і вся функція встигала вичерпати свій ліміт часу на Vercel.
      const dbP = probe("dbrest", locationsDbRest(query));
      const tP = probe("transitous", locationsTransitous(query));
      const win = await firstUseful([dbP, tP]);
      if (win) {
        res.status(200).json({ source: win.name, items: mergeLocations([win.items]) });
        return;
      }
      const both = await Promise.all([dbP, tP]);
      res.status(502).json({
        error: "no source available",
        errors: both.map((r) => r.name + ": " + (r.ok ? "empty" : r.err)),
      });
      return;
    }

    if (path === "/journeys") {
      // Станцію відправлення можна передати вже готовим id (from) АБО
      // сирим текстом (fromQuery) — тоді сервер сам її шукає в межах
      // цього самого запиту. Це прибирає окремий похід клієнта за
      // координатами станції перед пошуком розкладу: один мережевий
      // раунд-тріп замість двох у типовому випадку (однозначна назва).
      let resolvedFrom = from;
      if (!resolvedFrom && req.query.fromQuery) {
        const fq = String(req.query.fromQuery);
        // Так само паралельно, з тієї ж причини: послідовні спроби
        // складаються в суму таймаутів і не вкладаються в ліміт функції.
        const w = await firstUseful([
          probe("dbrest", locationsDbRest(fq)),
          probe("transitous", locationsTransitous(fq)),
        ]);
        const originList = w ? w.items : [];
        if (originList.length === 1) {
          resolvedFrom = originList[0].id;
        } else if (originList.length > 1) {
          // Кілька станцій підходять під назву — просимо клієнта уточнити,
          // замість вгадувати. Той самий список, що показав би /locations.
          res.status(200).json({ needsDisambiguation: true, options: mergeLocations([originList]) });
          return;
        } else {
          res.status(404).json({ error: "origin not found" });
          return;
        }
      }
      if (!resolvedFrom || !to) { res.status(400).json({ error: "no from/to" }); return; }
      const from2 = resolvedFrom;
      const useT = String(from2).startsWith("T:") || String(to).startsWith("T:");
      const regionalOnly = String(req.query.regional || "") === "1";
      const debug = String(req.query.debug || "") === "1";
      const applyFilter = (arr) => {
        if (!regionalOnly) return arr;
        // Строго: якщо користувач просив лише регіональні — краще
        // показати менше варіантів, ніж підсунути ICE/IC.
        return arr.filter(isRegionalJourney);
      };
      // Страхувальна спроба. Обмеження видів транспорту задається в запиті,
      // і якщо сервіс колись перестане його розуміти або перевізник змінить
      // типізацію, пошук поверне порожньо. Тому на порожній результат
      // повторюємо запит без обмеження й відсіюємо далекобійні по-старому,
      // на готовому списку. Порожнього екрана бути не може.
      const transitousJourneys = async () => {
        const first = await journeysTransitous(from2, to, departure, regionalOnly);
        if (!regionalOnly || (first && first.length > 0)) return first;
        return journeysTransitous(from2, to, departure, regionalOnly, true);
      };
      const sources = useT
        ? [["transitous", transitousJourneys]]
        : [
            ["dbrest", () => journeysDbRest(from2, to, departure)],
            ["transitous", transitousJourneys],
          ];

      // Швидкий шлях (не для debug): обидва джерела стартують ОДРАЗУ, але
      // якщо офіційне вже саме дало достатньо варіантів — відповідаємо не
      // чекаючи запасне (воно просто відкидається, коли завершиться).
      // Значно скорочує типовий час очікування, коли DB відповідає добре.
      // Досить 3 варіантів від офіційного джерела, щоб відповісти одразу
      // й не чекати друге — типовий пошук стає помітно швидшим.
      // Планка піднята разом із запасом варіантів: трьох рейсів мало,
      // щоб вважати розклад повним, і швидка відповідь від офіційного
      // джерела обривала б добірку від запасного.
      const MIN_GOOD_ENOUGH = 12;
      if (!debug && !useT) {
        const dbPromise = journeysDbRest(from2, to, departure).then(applyFilter).catch(() => null);
        const tPromise = transitousJourneys().then(applyFilter).catch(() => null);
        const dbEarly = await dbPromise;
        if (dbEarly && dbEarly.length >= MIN_GOOD_ENOUGH) {
          res.status(200).json({ source: "dbrest", journeys: mergeJourneys([dbEarly]).slice(0, 12) });
          return;
        }
        const tEarly = await tPromise; // вже виконувався паралельно — просто забираємо
        const goodEarly = [];
        if (dbEarly && dbEarly.length > 0) goodEarly.push({ name: "dbrest", data: dbEarly });
        if (tEarly && tEarly.length > 0) goodEarly.push({ name: "transitous", data: tEarly });
        if (goodEarly.length === 0) {
          res.status(502).json({ error: "no source available" });
          return;
        }
        const mergedEarly = mergeJourneys(goodEarly.map((r) => r.data)).slice(0, 12);
        const sourceEarly = goodEarly.length > 1 ? "both" : goodEarly[0].name;
        res.status(200).json({ source: sourceEarly, journeys: mergedEarly });
        return;
      }

      const raw = await fetchAll(sources);
      // debug=1 показує сирі цифри від кожного джерела ДО фільтру й
      // об'єднання, ПЛЮС справжню необроблену відповідь Transitous —
      // щоб бачити факт, а не мій розбір цього факту.
      if (debug) {
        let rawSample = null, rawErr = null;
        try { rawSample = await rawJourneysTransitous(from2, to, departure); }
        catch (e) { rawErr = String((e && e.message) || e); }
        res.status(200).json({
          debug: true,
          sources: raw.map((r) => ({
            name: r.name,
            ok: r.ok,
            rawCount: r.ok ? r.data.length : 0,
            afterRegionalFilter: r.ok ? applyFilter(r.data).length : 0,
            error: r.ok ? null : String((r.err && r.err.message) || r.err),
          })),
          transitousRawSample: rawErr ? { error: rawErr } : {
            firstItinerary: rawSample && (rawSample.itineraries || (rawSample.plan && rawSample.plan.itineraries)) ? (rawSample.itineraries || rawSample.plan.itineraries)[0] : null,
            totalItineraries: rawSample && (rawSample.itineraries || (rawSample.plan && rawSample.plan.itineraries)) ? (rawSample.itineraries || rawSample.plan.itineraries).length : 0,
          },
        });
        return;
      }
      const results = raw.map((r) => (r.ok ? { ...r, data: applyFilter(r.data) } : r));
      const good = results.filter((r) => r.ok && r.data && r.data.length > 0);
      if (good.length === 0) {
        res.status(502).json({ error: "no source available", errors: results.map((r) => r.name + ": " + (r.ok ? "empty" : (r.err && r.err.message) || r.err)) });
        return;
      }
      const merged = mergeJourneys(good.map((r) => r.data)).slice(0, 12);
      const source = good.length > 1 ? "both" : good[0].name;
      res.status(200).json({ source, journeys: merged });
      return;
    }

    res.status(400).json({ error: "bad path" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
