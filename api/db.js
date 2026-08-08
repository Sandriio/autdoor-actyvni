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
const DBREST_TIMEOUT_MS = 9000;
const TRANSITOUS_TIMEOUT_MS = 8000;

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
  const p = new URLSearchParams({ from, to, results: "10", stopovers: "false" });
  if (departure) p.set("departure", departure);
  const j = await getJson(`${DBREST}/journeys?${p}`, DBREST_TIMEOUT_MS);
  return (j && j.journeys) || [];
}

const iso = (v) => (v ? String(v) : null);

// Далекобійні поїзди (за назвою — запасний варіант, якщо немає структурованого поля).
const LONG_DISTANCE = /^(ICE|IC|EC|ECE|RJX|RJ|TGV|FLX|NJ|EN|THA|WB)\b/i;
// Дозволені види транспорту: регіональні поїзди, S-Bahn, автобуси
// (Ersatzverkehr — заміна поїзда автобусом — теж рахується як bus).
// Явно ВИКЛЮЧЕНІ: метро/U-Bahn, трамваї, пороми, таксі, далекобійні.
const ALLOWED_PRODUCTS = new Set(["regionalexpress", "regional", "suburban", "bus"]);
const ALLOWED_GTFS_MODES = new Set(["RAIL", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL", "SUBURBAN", "BUS", "COACH"]);
function isRegionalJourney(jr) {
  return (jr.legs || []).every((l) => {
    if (l.walking) return true;
    // db-rest (HAFAS) віддає line.product — найточніше джерело.
    const product = l.line && l.line.product ? String(l.line.product).toLowerCase() : null;
    if (product) return ALLOWED_PRODUCTS.has(product);
    // Transitous (GTFS) віддає mode окремим полем.
    const mode = l.mode ? String(l.mode).toUpperCase() : null;
    if (mode) return ALLOWED_GTFS_MODES.has(mode);
    // Запасний варіант, якщо структурованих полів немає: за назвою лінії
    // виключаємо хоча б явно далекобійні.
    const name = (l.line && l.line.name) || "";
    return !LONG_DISTANCE.test(String(name).trim());
  });
}
const delaySec = (actual, planned) => {
  if (!actual || !planned) return 0;
  const d = (new Date(actual) - new Date(planned)) / 1000;
  return isNaN(d) ? 0 : d;
};

// Приводимо відповідь Transitous до вигляду DB, щоб застосунок не
// помічав різниці між джерелами.
async function journeysTransitous(from, to, departure, regionalOnly) {
  const p = new URLSearchParams({
    fromPlace: String(from).replace(/^T:/, ""),
    toPlace: String(to).replace(/^T:/, ""),
    numItineraries: "10",
  });
  if (departure) p.set("time", new Date(departure).toISOString());
  // Режим «розклад»: віддає рейси підряд у вікні часу, а не лише кілька
  // найшвидших.
  p.set("timetableView", "true");
  p.set("searchWindow", "21600");
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
      return {
        walking,
        cancelled: Boolean(l.cancelled),
        origin: { name: f.name || "" },
        destination: { name: tt.name || "" },
        departure: depActual,
        plannedDeparture: depPlanned,
        departureDelay: delaySec(depActual, depPlanned),
        departurePlatform: f.track || f.scheduledTrack || null,
        plannedDeparturePlatform: f.scheduledTrack || null,
        arrival: arrActual,
        plannedArrival: arrPlanned,
        arrivalDelay: delaySec(arrActual, arrPlanned),
        mode: l.mode || null,
        line: { name: l.routeShortName || l.routeLongName || l.displayName || l.mode || "" },
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
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");

  try {
    if (path === "/locations") {
      if (!query) { res.status(400).json({ error: "no query" }); return; }
      // Спершу тільки офіційне джерело — воно чисте (лише вокзали) і
      // зазвичай швидке для простого пошуку станції. Запасне підключаємо
      // ЛИШЕ якщо перше не спрацювало, а не завжди — так і швидше
      // (не чекаємо друге даремно), і чистіше (без готелів/POI).
      let dbErr = null;
      try {
        const dbData = await locationsDbRest(query);
        if (dbData.length > 0) {
          res.status(200).json({ source: "dbrest", items: mergeLocations([dbData]) });
          return;
        }
      } catch (e) { dbErr = (e && e.message) || String(e); }
      try {
        const tData = await locationsTransitous(query);
        if (tData.length > 0) {
          res.status(200).json({ source: "transitous", items: mergeLocations([tData]) });
          return;
        }
        res.status(502).json({ error: "no source available", errors: [dbErr ? "dbrest: " + dbErr : "dbrest: empty", "transitous: empty"] });
      } catch (e) {
        res.status(502).json({ error: "no source available", errors: [dbErr ? "dbrest: " + dbErr : "dbrest: empty", "transitous: " + ((e && e.message) || e)] });
      }
      return;
    }

    if (path === "/journeys") {
      if (!from || !to) { res.status(400).json({ error: "no from/to" }); return; }
      const useT = String(from).startsWith("T:") || String(to).startsWith("T:");
      const regionalOnly = String(req.query.regional || "") === "1";
      const debug = String(req.query.debug || "") === "1";
      const applyFilter = (arr) => {
        if (!regionalOnly) return arr;
        const f = arr.filter(isRegionalJourney);
        return f.length > 0 ? f : arr;
      };
      const sources = useT
        ? [["transitous", () => journeysTransitous(from, to, departure, regionalOnly)]]
        : [
            ["dbrest", () => journeysDbRest(from, to, departure)],
            ["transitous", () => journeysTransitous(from, to, departure, regionalOnly)],
          ];

      // Швидкий шлях (не для debug): обидва джерела стартують ОДРАЗУ, але
      // якщо офіційне вже саме дало достатньо варіантів — відповідаємо не
      // чекаючи запасне (воно просто відкидається, коли завершиться).
      // Значно скорочує типовий час очікування, коли DB відповідає добре.
      const MIN_GOOD_ENOUGH = 6;
      if (!debug && !useT) {
        const dbPromise = journeysDbRest(from, to, departure).then(applyFilter).catch(() => null);
        const tPromise = journeysTransitous(from, to, departure, regionalOnly).then(applyFilter).catch(() => null);
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
        try { rawSample = await rawJourneysTransitous(from, to, departure); }
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
