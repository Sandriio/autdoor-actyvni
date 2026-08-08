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
// Скільки варіантів просити в сервісів (частину відсіє фільтр).
const WANT = "8";
// db-vendo-client офіційно обмежує запити з однієї IP і іноді відповідає
// повільно — довший таймаут і одна повторна спроба помітно знижують
// шанс марно провалитись у запасне джерело через тимчасову затримку.
// (9с × 2 спроби + 7с на Transitous = 25с — вписується в 30-секундний
// ліміт виконання функції на безкоштовному тарифі Vercel.)
const DBREST_TIMEOUT_MS = 9000;

async function getJson(url, timeoutMs = TIMEOUT_MS, retries = 0) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        // User-Agent з посиланням на проєкт — так радить документація
        // db-vendo-client, це знижує шанс потрапити під троттлінг.
        headers: { Accept: "application/json", "User-Agent": "autdoor-actyvni.vercel.app (community trips app)" },
      });
      clearTimeout(timer);
      if (r.status === 429) throw new Error("HTTP 429 (rate limit)");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── Пошук станцій ─────────────────────────────────────────────────────
async function locationsDbRest(query) {
  const p = new URLSearchParams({ query, results: "6", addresses: "false", poi: "false" });
  const j = await getJson(`${DBREST}/locations?${p}`, DBREST_TIMEOUT_MS, 1);
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
  const j = await getJson(`${DBREST}/journeys?${p}`, DBREST_TIMEOUT_MS, 1);
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
  // найшвидших. Вікно 6 годин — щоб було з чого обирати.
  p.set("timetableView", "true");
  p.set("searchWindow", "21600");
  // Дозволяємо пішохідні пересадки між вокзалами — без цього губляться
  // варіанти, які показує офіційний застосунок DB.
  p.set("maxPreTransitTime", "900");
  p.set("maxPostTransitTime", "900");
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
      // Джерело чесно позначається в полі source, щоб було видно, звідки
      // саме взялись дані — а не лише декларативно.
      const sources = [["dbrest", locationsDbRest], ["transitous", locationsTransitous]];
      for (const [src, fn] of sources) {
        try {
          const out = await fn(query);
          if (out.length > 0) { res.status(200).json({ source: src, items: out }); return; }
          errors.push(src + ": empty");
        } catch (e) { errors.push(src + ": " + ((e && e.message) || e)); }
      }
      res.status(502).json({ error: "no source available", errors });
      return;
    }

    if (path === "/journeys") {
      if (!from || !to) { res.status(400).json({ error: "no from/to" }); return; }
      const useT = String(from).startsWith("T:") || String(to).startsWith("T:");
      const regionalOnly = String(req.query.regional || "") === "1";
      const chain = useT ? [["transitous", journeysTransitous]] : [["dbrest", journeysDbRest], ["transitous", journeysTransitous]];
      for (const [src, fn] of chain) {
        try {
          let out = await fn(from, to, departure, regionalOnly);
          // Підстраховка: навіть якщо сервіс проігнорував фільтр, прибираємо
          // варіанти з ICE/IC/EC вручну.
          if (regionalOnly) {
            const filtered = out.filter(isRegionalJourney);
            if (filtered.length > 0) out = filtered;
          }
          if (out.length > 0) { res.status(200).json({ source: src, journeys: out }); return; }
          errors.push(src + ": empty");
        } catch (e) { errors.push(src + ": " + ((e && e.message) || e)); }
      }
      res.status(502).json({ error: "no source available", errors });
      return;
    }

    res.status(400).json({ error: "bad path" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e), errors });
  }
}
