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
  const p = new URLSearchParams({ query, results: "6", addresses: "false", poi: "false" });
  const j = await getJson(`${DBREST}/locations?${p}`, DBREST_TIMEOUT_MS);
  return (j || [])
    .filter((x) => x && x.id && x.name)
    .map((x) => ({ id: String(x.id), name: x.name }));
}
async function locationsTransitous(query) {
  const p = new URLSearchParams({ text: query, language: "de" });
  const j = await getJson(`${TRANSITOUS}/api/v1/geocode?${p}`, TRANSITOUS_TIMEOUT_MS);
  const arr = Array.isArray(j) ? j : (j && j.results) || [];
  return arr
    .filter((x) => x && (x.id || x.stopId) && x.name)
    .map((x) => ({ id: "T:" + String(x.id || x.stopId), name: x.name }))
    .slice(0, 6);
}
function mergeLocations(lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const x of list) {
      const key = x.name.trim().toLowerCase();
      if (!seen.has(key)) seen.set(key, x);
    }
  }
  return [...seen.values()].slice(0, 8);
}

// ── Пошук рейсів ──────────────────────────────────────────────────────
async function journeysDbRest(from, to, departure, regionalOnly) {
  const p = new URLSearchParams({ from, to, results: "8", stopovers: "false" });
  if (departure) p.set("departure", departure);
  if (regionalOnly) {
    // Вимикаємо далекобійні поїзди (ICE/IC/EC) — Deutschland-Ticket і
    // Bayern-Ticket на них не діють.
    p.set("nationalExpress", "false");
    p.set("national", "false");
    p.set("regionalExpress", "true");
    p.set("regional", "true");
    p.set("suburban", "true");
    p.set("bus", "true");
    p.set("subway", "true");
    p.set("tram", "true");
    p.set("ferry", "true");
    p.set("taxi", "true");
  }
  const j = await getJson(`${DBREST}/journeys?${p}`, DBREST_TIMEOUT_MS);
  return (j && j.journeys) || [];
}

const iso = (v) => (v ? String(v) : null);

// Далекобійні поїзди, на які не діють Deutschland-/Bayern-Ticket.
const LONG_DISTANCE = /^(ICE|IC|EC|ECE|RJX|RJ|TGV|FLX|NJ|EN|THA|WB)\b/i;
function isRegionalJourney(jr) {
  return (jr.legs || []).every((l) => {
    if (l.walking) return true;
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
  const j = await getJson(`${TRANSITOUS}/api/v1/plan?${p}`, TRANSITOUS_TIMEOUT_MS);
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
        line: { name: l.routeShortName || l.routeLongName || l.displayName || l.mode || "" },
      };
    }),
  }));
}

// Ключ для порівняння рейсів між джерелами: час відправлення+прибуття з
// точністю до хвилини. Той самий фізичний поїзд з різних джерел матиме
// однаковий ключ і не продублюється.
function journeyKey(jr) {
  const ls = (jr.legs || []).filter((l) => !l.walking);
  if (ls.length === 0) return null;
  const dep = ls[0].plannedDeparture || ls[0].departure || "";
  const arr = ls[ls.length - 1].plannedArrival || ls[ls.length - 1].arrival || "";
  return String(dep).slice(0, 16) + "|" + String(arr).slice(0, 16);
}
function mergeJourneys(lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const jr of list) {
      const k = journeyKey(jr);
      if (k && !seen.has(k)) seen.set(k, jr);
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

export default async function handler(req, res) {
  const { path, query, from, to, departure } = req.query || {};
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");

  try {
    if (path === "/locations") {
      if (!query) { res.status(400).json({ error: "no query" }); return; }
      const results = await fetchAll([
        ["dbrest", () => locationsDbRest(query)],
        ["transitous", () => locationsTransitous(query)],
      ]);
      const good = results.filter((r) => r.ok && r.data && r.data.length > 0);
      if (good.length === 0) {
        res.status(502).json({ error: "no source available", errors: results.map((r) => r.name + ": " + (r.ok ? "empty" : (r.err && r.err.message) || r.err)) });
        return;
      }
      const merged = mergeLocations(good.map((r) => r.data));
      const source = good.length > 1 ? "both" : good[0].name;
      res.status(200).json({ source, items: merged });
      return;
    }

    if (path === "/journeys") {
      if (!from || !to) { res.status(400).json({ error: "no from/to" }); return; }
      const useT = String(from).startsWith("T:") || String(to).startsWith("T:");
      const regionalOnly = String(req.query.regional || "") === "1";
      const applyFilter = (arr) => {
        if (!regionalOnly) return arr;
        const f = arr.filter(isRegionalJourney);
        return f.length > 0 ? f : arr;
      };
      const sources = useT
        ? [["transitous", () => journeysTransitous(from, to, departure, regionalOnly).then(applyFilter)]]
        : [
            ["dbrest", () => journeysDbRest(from, to, departure, regionalOnly).then(applyFilter)],
            ["transitous", () => journeysTransitous(from, to, departure, regionalOnly).then(applyFilter)],
          ];
      const results = await fetchAll(sources);
      const good = results.filter((r) => r.ok && r.data && r.data.length > 0);
      if (good.length === 0) {
        res.status(502).json({ error: "no source available", errors: results.map((r) => r.name + ": " + (r.ok ? "empty" : (r.err && r.err.message) || r.err)) });
        return;
      }
      const merged = mergeJourneys(good.map((r) => r.data)).slice(0, 8);
      const source = good.length > 1 ? "both" : good[0].name;
      res.status(200).json({ source, journeys: merged });
      return;
    }

    res.status(400).json({ error: "bad path" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
