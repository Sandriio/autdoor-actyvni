// Проксі до сервісів розкладу поїздів.
// Джерело 1: v6.db.transport.rest (дані DB Navigator).
// Джерело 2: api.transitous.org (MOTIS, відкриті дані GTFS) — якщо перше
// не відповідає. Обидва безкоштовні й не потребують ключів.
//
// Запити йдуть із сервера Vercel, а не з телефона, і мають жорсткий
// таймаут, щоб сторінка ніколи не «зависала».

const DBREST = "https://v6.db.transport.rest";
const TRANSITOUS = "https://api.transitous.org";
const TIMEOUT_MS = 7000;

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { Accept: "application/json", "User-Agent": "autdoor-actyvni community trips app" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Пошук станцій ─────────────────────────────────────────────────────
async function locationsDbRest(query) {
  const p = new URLSearchParams({ query, results: "6", addresses: "false", poi: "false" });
  const j = await getJson(`${DBREST}/locations?${p}`);
  return (j || [])
    .filter((x) => x && x.id && x.name)
    .map((x) => ({ id: String(x.id), name: x.name }));
}
async function locationsTransitous(query) {
  const p = new URLSearchParams({ text: query, language: "de" });
  const j = await getJson(`${TRANSITOUS}/api/v1/geocode?${p}`);
  const arr = Array.isArray(j) ? j : (j && j.results) || [];
  return arr
    .filter((x) => x && (x.id || x.stopId) && x.name)
    .map((x) => ({ id: "T:" + String(x.id || x.stopId), name: x.name }))
    .slice(0, 6);
}

// ── Пошук рейсів ──────────────────────────────────────────────────────
async function journeysDbRest(from, to, departure) {
  const p = new URLSearchParams({ from, to, results: "4", stopovers: "false" });
  if (departure) p.set("departure", departure);
  const j = await getJson(`${DBREST}/journeys?${p}`);
  return (j && j.journeys) || [];
}

const iso = (v) => (v ? String(v) : null);
const delaySec = (actual, planned) => {
  if (!actual || !planned) return 0;
  const d = (new Date(actual) - new Date(planned)) / 1000;
  return isNaN(d) ? 0 : d;
};

// Приводимо відповідь Transitous до вигляду DB, щоб застосунок не
// помічав різниці між джерелами.
async function journeysTransitous(from, to, departure) {
  const p = new URLSearchParams({
    fromPlace: String(from).replace(/^T:/, ""),
    toPlace: String(to).replace(/^T:/, ""),
    numItineraries: "4",
  });
  if (departure) p.set("time", new Date(departure).toISOString());
  const j = await getJson(`${TRANSITOUS}/api/v1/plan?${p}`);
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

export default async function handler(req, res) {
  const { path, query, from, to, departure } = req.query || {};
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");

  const errors = [];
  try {
    if (path === "/locations") {
      if (!query) { res.status(400).json({ error: "no query" }); return; }
      for (const fn of [locationsDbRest, locationsTransitous]) {
        try {
          const out = await fn(query);
          if (out.length > 0) { res.status(200).json(out); return; }
          errors.push(fn.name + ": empty");
        } catch (e) { errors.push(fn.name + ": " + ((e && e.message) || e)); }
      }
      res.status(502).json({ error: "no source available", errors });
      return;
    }

    if (path === "/journeys") {
      if (!from || !to) { res.status(400).json({ error: "no from/to" }); return; }
      const useT = String(from).startsWith("T:") || String(to).startsWith("T:");
      const chain = useT ? [journeysTransitous] : [journeysDbRest, journeysTransitous];
      for (const fn of chain) {
        try {
          const out = await fn(from, to, departure);
          if (out.length > 0) { res.status(200).json({ journeys: out }); return; }
          errors.push(fn.name + ": empty");
        } catch (e) { errors.push(fn.name + ": " + ((e && e.message) || e)); }
      }
      res.status(502).json({ error: "no source available", errors });
      return;
    }

    res.status(400).json({ error: "bad path" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e), errors });
  }
}
