// ═══ Tropa Club · src/route-tools.js · ВЕРСІЯ r1 ═══
// ═══════════════════════════════════════════════════════════════════
// Маршрут із файлу чи посилання → точки для розділу «Маршрут» (v144)
//
// Тут лише розрахунки й запити до відкритих карт; кнопки — в App.jsx.
//  1. Файл GPX (Komoot, Bergfex, Outdooractive…), KML (Google My Maps,
//     Google Earth) чи GeoJSON → трек і позначені в ньому точки.
//  2. Відстань, набір і скидання висоти. Немає висот у файлі (KML із
//     Google, маршрут із Google Maps) — беремо їх з Open-Meteo.
//  3. Місця поруч із треком — з OpenStreetMap (Overpass API): вокзали,
//     вершини, хатини, оглядові майданчики, озера, водоспади, каплиці,
//     замки; у місті — пам'ятки, площі, музеї, церкви, парки.
//  4. Час на кожній точці — за правилом німецьких туристичних клубів
//     (DIN 33466): 4 км за годину по рівному, 300 м підйому або 500 м
//     спуску за годину; плюс зупинки, які обрав Claude. Місто — 3,5 км/год.
// Усі три служби безкоштовні й без ключа.
// ═══════════════════════════════════════════════════════════════════

export const ROUTE_TOOLS_VERSION = "r1";
const RAD = Math.PI / 180;

// Відстань між двома точками, метри.
export function distM(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Таймер для запиту: AbortSignal.timeout є не на всіх iPhone.
export function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => { try { c.abort(); } catch { /* уже не потрібен */ } }, ms);
  return c.signal;
}

// ── 1. Файл ──────────────────────────────────────────────────────────
const fail = (code) => Object.assign(new Error(code), { code });
const byTag = (root, name) => Array.from(root.getElementsByTagNameNS ? root.getElementsByTagNameNS("*", name) : root.getElementsByTagName(name));
const kids = (el) => Array.from((el && el.childNodes) || []).filter((n) => n.nodeType === 1);
const child = (el, name) => kids(el).find((n) => (n.localName || n.nodeName) === name) || null;
const childText = (el, name) => { const c = child(el, name); return c ? String(c.textContent || "").replace(/\s+/g, " ").trim() : ""; };
const okLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

function gpxPoint(el) {
  const lat = parseFloat(el.getAttribute("lat")), lng = parseFloat(el.getAttribute("lon"));
  if (!okLatLng(lat, lng)) return null;
  const e = parseFloat(childText(el, "ele"));
  return { lat, lng, ele: Number.isFinite(e) ? e : null };
}
function parseGpx(doc) {
  const root = doc.documentElement;
  let pts = byTag(root, "trkpt");
  if (pts.length < 2) pts = byTag(root, "rtept");
  const track = pts.map(gpxPoint).filter(Boolean);
  const wpts = byTag(root, "wpt").map((w) => {
    const p = gpxPoint(w);
    if (!p) return null;
    return { ...p, name: childText(w, "name"), desc: childText(w, "desc") || childText(w, "cmt"), type: childText(w, "type") || childText(w, "sym") };
  }).filter(Boolean);
  const trk = child(root, "trk") || child(root, "rte");
  const md = child(root, "metadata");
  return { format: "gpx", name: (trk && childText(trk, "name")) || (md && childText(md, "name")) || "", track, wpts };
}

// «11.57,48.13,520 11.58,48.14,522» → точки. Висота 0 у KML означає
// «невідомо» (Google My Maps завжди пише 0).
function kmlCoords(text) {
  return String(text || "").replace(/\s*,\s*/g, ",").trim().split(/\s+/).map((tok) => {
    const [lng, lat, alt] = tok.split(",").map(Number);
    if (!okLatLng(lat, lng)) return null;
    return { lat, lng, ele: Number.isFinite(alt) && alt !== 0 ? alt : null };
  }).filter(Boolean);
}
// Кілька ліній одного маршруту (Google My Maps кладе кожен відрізок
// окремо) — зшиваємо по черзі, розвертаючи, якщо треба. Те, що не
// зшивається, — окремі шматки; беремо найдовший.
function joinLines(lines) {
  const groups = [];
  for (const ln of lines.filter((l) => l.length >= 2)) {
    const g = groups[groups.length - 1];
    if (g) {
      const end = g[g.length - 1];
      if (distM(end, ln[0]) < 150) { for (let i = 1; i < ln.length; i++) g.push(ln[i]); continue; }
      if (distM(end, ln[ln.length - 1]) < 150) { for (let i = ln.length - 2; i >= 0; i--) g.push(ln[i]); continue; }
    }
    groups.push(ln.slice());
  }
  let best = [], bestLen = -1;
  for (const g of groups) {
    let len = 0;
    for (let i = 1; i < g.length; i++) len += distM(g[i - 1], g[i]);
    if (len > bestLen) { best = g; bestLen = len; }
  }
  return best;
}
function parseKml(doc) {
  const root = doc.documentElement;
  const lines = [], wpts = [];
  for (const pm of byTag(root, "Placemark")) {
    const name = childText(pm, "name");
    for (const ls of byTag(pm, "LineString")) lines.push(kmlCoords(childText(ls, "coordinates")));
    for (const tr of byTag(pm, "Track")) {
      lines.push(byTag(tr, "coord").map((c) => {
        const [lng, lat, alt] = String(c.textContent || "").trim().split(/\s+/).map(Number);
        return okLatLng(lat, lng) ? { lat, lng, ele: Number.isFinite(alt) && alt !== 0 ? alt : null } : null;
      }).filter(Boolean));
    }
    for (const p of byTag(pm, "Point")) {
      const c = kmlCoords(childText(p, "coordinates"))[0];
      if (c) wpts.push({ ...c, name, desc: childText(pm, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200), type: "" });
    }
  }
  const docEl = byTag(root, "Document")[0];
  return { format: "kml", name: (docEl && childText(docEl, "name")) || "", track: joinLines(lines), wpts };
}
function parseGeoJson(o) {
  const feats = o && o.type === "FeatureCollection" ? o.features || []
    : o && o.type === "Feature" ? [o] : [{ type: "Feature", geometry: o, properties: {} }];
  const lines = [], wpts = [];
  const pt = (c) => (Array.isArray(c) && okLatLng(c[1], c[0]) ? { lat: c[1], lng: c[0], ele: Number.isFinite(c[2]) && c[2] !== 0 ? c[2] : null } : null);
  for (const f of feats) {
    const g = f && f.geometry;
    const props = (f && f.properties) || {};
    if (!g) continue;
    if (g.type === "LineString") lines.push((g.coordinates || []).map(pt).filter(Boolean));
    if (g.type === "MultiLineString") (g.coordinates || []).forEach((l) => lines.push((l || []).map(pt).filter(Boolean)));
    if (g.type === "Point") { const p = pt(g.coordinates); if (p) wpts.push({ ...p, name: String(props.name || props.title || "").trim(), desc: "", type: "" }); }
  }
  return { format: "geojson", name: String((o && o.name) || "").trim(), track: joinLines(lines), wpts };
}

// Текст файлу → { format, name, track: [{lat,lng,ele}], wpts: [{lat,lng,ele,name}] }.
// Помилки: code «kmz» (стиснутий KMZ), «bad» (пошкоджений), «format»
// (не маршрут), «empty» (немає точок).
export function parseRouteText(text, Parser) {
  const s = String(text || "").replace(/^﻿/, "").trim();
  if (s.startsWith("PK")) throw fail("kmz");
  if (!s) throw fail("empty");
  let r;
  if (s[0] === "{" || s[0] === "[") {
    let o;
    try { o = JSON.parse(s); } catch { throw fail("bad"); }
    r = parseGeoJson(o);
  } else {
    const P = Parser || (typeof DOMParser !== "undefined" ? DOMParser : null);
    if (!P) throw fail("bad");
    let doc;
    try { doc = new P().parseFromString(s, "application/xml"); } catch { throw fail("bad"); }
    if (!doc || !doc.documentElement || byTag(doc, "parsererror").length) throw fail("bad");
    const root = String(doc.documentElement.localName || doc.documentElement.nodeName).toLowerCase();
    if (root === "gpx") r = parseGpx(doc);
    else if (root === "kml") r = parseKml(doc);
    else throw fail("format");
  }
  // Однакові точки поспіль — геть; дуже довгий трек — рідше.
  const track = [];
  for (const p of r.track) {
    const last = track[track.length - 1];
    if (!last || last.lat !== p.lat || last.lng !== p.lng) track.push(p);
  }
  const step = Math.ceil(track.length / 60000);
  r.track = step > 1 ? track.filter((_, i) => i % step === 0 || i === track.length - 1) : track;
  r.wpts = r.wpts.slice(0, 60);
  if (r.track.length < 2 && r.wpts.length < 2) throw fail("empty");
  return r;
}

// ── 2. Відстань і висоти ─────────────────────────────────────────────
export function cumKm(track) {
  const c = [0];
  for (let i = 1; i < track.length; i++) c.push(c[i - 1] + distM(track[i - 1], track[i]) / 1000);
  return c;
}
// Рідший трек для швидких розрахунків: точка не ближче ніж через minM.
export function thin(track, minM = 15) {
  if (track.length <= 2) return track.slice();
  const out = [track[0]];
  for (let i = 1; i < track.length - 1; i++) if (distM(out[out.length - 1], track[i]) >= minM) out.push(track[i]);
  out.push(track[track.length - 1]);
  return out;
}
export function hasElevation(track) {
  let n = 0, min = Infinity, max = -Infinity;
  for (const p of track) {
    if (p.ele == null || !Number.isFinite(p.ele)) continue;
    n++; if (p.ele < min) min = p.ele; if (p.ele > max) max = p.ele;
  }
  return track.length > 1 && n >= track.length * 0.8 && max - min >= 1;
}
// Точка на заданій відстані від старту (лінійно між сусідніми точками).
function pointAt(track, cum, km, from) {
  let i = Math.max(1, from || 1);
  while (i < cum.length - 1 && cum[i] < km) i++;
  const a = track[i - 1], b = track[i];
  const seg = cum[i] - cum[i - 1];
  const t = seg > 0 ? Math.min(1, Math.max(0, (km - cum[i - 1]) / seg)) : 0;
  const ele = a.ele != null && b.ele != null ? a.ele + t * (b.ele - a.ele) : (a.ele != null ? a.ele : b.ele);
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng), ele, i };
}
// Профіль: точки через рівні відстані — з треку, де висоти вже є.
export function profileOf(track, cum, stepM = 25) {
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.min(4000, Math.round((total * 1000) / stepM)));
  const out = [];
  let from = 1;
  for (let k = 0; k <= n; k++) {
    const km = (total * k) / n;
    const p = pointAt(track, cum, km, from);
    from = p.i;
    out.push({ km, ele: p.ele, lat: p.lat, lng: p.lng });
  }
  // Прогалини у висотах (частина точок без висоти) — висотою сусіда.
  for (let i = 1; i < out.length; i++) if (out[i].ele == null) out[i].ele = out[i - 1].ele;
  for (let i = out.length - 2; i >= 0; i--) if (out[i].ele == null) out[i].ele = out[i + 1].ele;
  return out;
}
// Висоти з Open-Meteo (модель рельєфу Copernicus, 90 м): до 200 точок
// уздовж треку, двома запитами по сто.
export async function elevationProfile(track, cum, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const total = cum[cum.length - 1];
  const n = Math.min(199, Math.max(10, Math.round((total * 1000) / 70)));
  const pts = [];
  let from = 1;
  for (let k = 0; k <= n; k++) {
    const km = (total * k) / n;
    const p = pointAt(track, cum, km, from);
    from = p.i;
    pts.push({ km, lat: p.lat, lng: p.lng, ele: null });
  }
  for (let s = 0; s < pts.length; s += 100) {
    const part = pts.slice(s, s + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${part.map((p) => p.lat.toFixed(5)).join(",")}&longitude=${part.map((p) => p.lng.toFixed(5)).join(",")}`;
    const r = await doFetch(url, { signal: timeoutSignal(15000) });
    if (!r.ok) throw fail("elev");
    const j = await r.json();
    const e = (j && j.elevation) || [];
    part.forEach((p, i) => { p.ele = Number.isFinite(e[i]) ? e[i] : null; });
  }
  if (pts.filter((p) => p.ele != null).length < pts.length * 0.8) throw fail("elev");
  // Прогалини — висотою сусіда (і на початку, і в кінці).
  for (let i = 1; i < pts.length; i++) if (pts[i].ele == null) pts[i].ele = pts[i - 1].ele;
  for (let i = pts.length - 2; i >= 0; i--) if (pts[i].ele == null) pts[i].ele = pts[i + 1].ele;
  return pts;
}
// Набір і скидання: згладжування (шум GPS) і поріг 4 м — дрібні
// «зубці» не рахуються, як і в Komoot. cumUp/cumDown — наростом.
export function climbOf(prof) {
  const n = prof.length;
  if (n < 2 || prof.some((p) => p.ele == null)) return null;
  const step = (prof[n - 1].km - prof[0].km) / (n - 1);
  const w = step * 1000 <= 40 ? 2 : step * 1000 <= 80 ? 1 : 0;
  // Вікно симетричне й звужується до країв: старт і фініш лишаються
  // справжніми, інакше на крутому початку висота «сповзала» б угору.
  const sm = prof.map((_, i) => {
    const wi = Math.min(w, i, n - 1 - i);
    let s = 0;
    for (let j = i - wi; j <= i + wi; j++) s += prof[j].ele;
    return s / (2 * wi + 1);
  });
  const TH = 4;
  let ref = sm[0], up = 0, down = 0;
  const cumUp = [0], cumDown = [0];
  for (let i = 1; i < n; i++) {
    const d = sm[i] - ref;
    if (d >= TH) { up += d; ref = sm[i]; } else if (d <= -TH) { down -= d; ref = sm[i]; }
    cumUp.push(up); cumDown.push(down);
  }
  return { up, down, cumUp, cumDown, smooth: sm };
}
// Підсумок маршруту для показу й для Claude.
export function routeStats(track, cum, prof, climb) {
  const km = cum[cum.length - 1];
  const out = { km: Math.round(km * 10) / 10, up: null, down: null, maxEle: null, minEle: null, startEle: null, endEle: null, topKm: null, loop: false };
  out.loop = km > 1 && distM(track[0], track[track.length - 1]) < 300;
  if (climb) {
    out.up = Math.round(climb.up / 10) * 10;
    out.down = Math.round(climb.down / 10) * 10;
    let max = -Infinity, min = Infinity, at = 0;
    climb.smooth.forEach((e, i) => { if (e > max) { max = e; at = i; } if (e < min) min = e; });
    out.maxEle = Math.round(max); out.minEle = Math.round(min);
    out.startEle = Math.round(climb.smooth[0]); out.endEle = Math.round(climb.smooth[climb.smooth.length - 1]);
    out.topKm = prof[at].km;
  }
  return out;
}

// Найближче місце на треку: { off (м від треку), km (від старту) }.
// fromKm — шукати лише далі за цю відстань (зупинки йдуть по черзі:
// на кільці фініш і старт в одному місці, і без цього фініш опинився б
// на нульовому кілометрі).
export function locate(p, track, cum, fromKm) {
  const kx = Math.cos(p.lat * RAD) * 111320, ky = 110540;
  let best = { off: Infinity, km: 0 };
  for (let i = 1; i < track.length; i++) {
    if (fromKm != null && cum[i] < fromKm) continue;
    const a = track[i - 1], b = track[i];
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
    const dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * ky;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.off - 0.5) best = { off: d, km: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
  }
  return best;
}
// Сітка відрізків треку: найближчий відрізок шукаємо лише в сусідніх
// клітинках, а не по всьому треку. Інакше довгий маршрут із тисячами
// місць поруч «підвішував» би телефон на кілька секунд.
export function trackGrid(track, cum, cellM = 400) {
  const lat0 = track[0].lat;
  const cy = cellM / 110540, cx = cellM / (111320 * Math.cos(lat0 * RAD));
  const cells = new Map();
  for (let s = 1; s < track.length; s++) {
    const a = track[s - 1], b = track[s];
    const i0 = Math.floor(Math.min(a.lat, b.lat) / cy), i1 = Math.floor(Math.max(a.lat, b.lat) / cy);
    const j0 = Math.floor(Math.min(a.lng, b.lng) / cx), j1 = Math.floor(Math.max(a.lng, b.lng) / cx);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i},${j}`;
      let arr = cells.get(k);
      if (!arr) { arr = []; cells.set(k, arr); }
      arr.push(s);
    }
  }
  return {
    // { off, km } найближчого відрізка, якщо він не далі за maxM; інакше null.
    near(p, maxM) {
      const r = Math.max(1, Math.ceil(maxM / cellM));
      const ci = Math.floor(p.lat / cy), cj = Math.floor(p.lng / cx);
      const kx = Math.cos(p.lat * RAD) * 111320, ky = 110540;
      const seen = new Set();
      let best = null;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        const arr = cells.get(`${i},${j}`);
        if (!arr) continue;
        for (const s of arr) {
          if (seen.has(s)) continue;
          seen.add(s);
          const a = track[s - 1], b = track[s];
          const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
          const dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * ky;
          const L2 = dx * dx + dy * dy;
          let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          const km = cum[s - 1] + t * (cum[s] - cum[s - 1]);
          if (!best || d < best.off - 0.5 || (Math.abs(d - best.off) <= 0.5 && km < best.km)) best = { off: d, km };
        }
      }
      return best && best.off <= maxM ? best : null;
    },
  };
}

// Відстань від треку до прямокутника (озеро): 0 — трек заходить усередину.
function nearBox(box, track, cum) {
  let best = { off: Infinity, km: 0 };
  const kyM = 110540;
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    const kx = Math.cos(p.lat * RAD) * 111320;
    const dx = p.lng < box.w ? (box.w - p.lng) * kx : p.lng > box.e ? (p.lng - box.e) * kx : 0;
    const dy = p.lat < box.s ? (box.s - p.lat) * kyM : p.lat > box.n ? (p.lat - box.n) * kyM : 0;
    const d = Math.hypot(dx, dy);
    if (d < best.off) best = { off: d, km: cum[i] };
    if (d === 0) break;
  }
  return best;
}

// ── 3. Місця поруч з OpenStreetMap ──────────────────────────────────
export const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

export function bboxOf(track, padM = 300) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of track) { if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; if (p.lng < w) w = p.lng; if (p.lng > e) e = p.lng; }
  const dLat = padM / 110540, dLng = padM / (111320 * Math.cos(((s + n) / 2) * RAD));
  return { s: s - dLat, w: w - dLng, n: n + dLat, e: e + dLng };
}
// Річки, канали й струмки теж бувають «natural=water» — це не озера.
const NOT_LAKE = "river|stream|canal|ditch|drain|riverbank|lock|moat|wastewater|fish_pass|basin";
// ends — старт і фініш: вокзал шукаємо до 800 м від них, село — до 1,5 км,
// навіть якщо це поза рамкою треку.
export function overpassQuery(b, kind, ends) {
  const bb = `(${[b.s, b.w, b.n, b.e].map((x) => x.toFixed(5)).join(",")})`;
  const common = [
    'node[railway~"^(station|halt)$"];',
    'nwr[tourism~"^(viewpoint|museum|attraction|gallery|zoo)$"];',
    'nwr[historic~"^(castle|ruins|monument|city_gate|fort|monastery|church|chapel|tower|archaeological_site|palace|manor)$"];',
    "nwr[amenity=place_of_worship];",
    "nwr[waterway=waterfall];",
    "nwr[natural=waterfall];",
    'nwr[man_made=tower]["tower:type"=observation];',
  ];
  const hike = [
    'node[natural~"^(peak|volcano|saddle|cave_entrance|spring)$"];',
    "node[mountain_pass=yes];",
    'nwr[tourism~"^(alpine_hut|wilderness_hut)$"];',
    'nwr[amenity~"^(restaurant|cafe|biergarten|pub)$"][name];',
    'nwr[natural~"^(gorge|beach)$"][name];',
    "nwr[leisure=bathing_place];",
    "node[aerialway=station];",
    'node[place~"^(village|hamlet|town)$"][name];',
  ];
  const city = [
    "nwr[place=square][name];",
    'nwr[leisure~"^(park|garden)$"][name];',
    'nwr[amenity~"^(fountain|marketplace|townhall)$"][name];',
    "nwr[man_made=bridge][name];",
    'nwr[building~"^(cathedral|church|chapel)$"][name];',
  ];
  const parts = common.concat(kind === "city" ? city : hike).map((q) => q.replace(/;$/, `${bb};`)).join("");
  const pts = [];
  for (const p of ends || []) if (p && !pts.some((x) => distM(x, p) < 100)) pts.push(p);
  const around = pts.map((p) => {
    const at = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    return `node[railway~"^(station|halt)$"](around:800,${at});node[place~"^(village|hamlet|town)$"][name](around:1500,${at});`;
  }).join("");
  const water = `way[natural=water][name][water!~"^(${NOT_LAKE})$"]${bb};relation[natural=water][name][water!~"^(${NOT_LAKE})$"]${bb};`;
  return `[out:json][timeout:25];(${parts}${around})->.a;(${water})->.w;.a out center;.w out bb;`;
}
// Спершу головний сервер, далі запасний. Простий POST (без особливих
// заголовків) — браузер не робить попереднього запиту.
export async function fetchOverpass(query, fetchImpl, timeoutMs = 30000) {
  const doFetch = fetchImpl || fetch;
  for (const url of OVERPASS_URLS) {
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: timeoutSignal(timeoutMs),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.elements)) return j.elements;
    } catch { /* наступний сервер */ }
  }
  throw fail("osm");
}

// Що це за місце — за тегами OpenStreetMap.
export function classify(t) {
  if (!t) return null;
  if (/^(station|halt)$/.test(t.railway || "") && t.station !== "subway" && t.station !== "light_rail") return "station";
  if (t.aerialway === "station") return "cable car station";
  if (t.natural === "peak" || t.natural === "volcano") return "peak";
  if (t.natural === "saddle" || t.mountain_pass === "yes") return "mountain pass";
  if (t.tourism === "alpine_hut" || t.tourism === "wilderness_hut") return "mountain hut";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "waterfall";
  if (t.natural === "water") return new RegExp(`^(${NOT_LAKE})$`).test(t.water || "") ? null : "lake";
  if (t.natural === "gorge") return "gorge";
  if (t.natural === "cave_entrance") return "cave";
  if (t.natural === "spring") return "spring";
  if (t.natural === "beach" || t.leisure === "bathing_place") return "bathing place";
  if (t.tourism === "viewpoint") return "viewpoint";
  if (t.man_made === "tower" && t["tower:type"] === "observation") return "observation tower";
  if (/^(castle|fort|palace|manor)$/.test(t.historic || "")) return "castle";
  if (t.historic === "ruins") return "ruins";
  if (t.historic === "monastery" || t.amenity === "monastery") return "monastery";
  if (t.amenity === "place_of_worship" || /^(church|chapel)$/.test(t.historic || "") || /^(cathedral|church|chapel)$/.test(t.building || "")) {
    return t.building === "chapel" || t.historic === "chapel" || /kapelle/i.test(t.name || "") ? "chapel" : "church";
  }
  if (t.tourism === "museum" || t.tourism === "gallery") return "museum";
  if (t.tourism === "zoo") return "zoo";
  if (t.historic === "city_gate") return "city gate";
  if (/^(monument|tower|archaeological_site)$/.test(t.historic || "")) return "monument";
  if (t.tourism === "attraction") return "sight";
  if (t.place === "square") return "square";
  if (t.leisure === "park" || t.leisure === "garden") return "park";
  if (t.amenity === "fountain") return "fountain";
  if (t.amenity === "marketplace") return "market";
  if (t.amenity === "townhall") return "town hall";
  if (t.man_made === "bridge") return "bridge";
  if (/^(restaurant|biergarten|pub)$/.test(t.amenity || "")) return t.amenity === "biergarten" ? "beer garden" : "restaurant";
  if (t.amenity === "cafe") return "cafe";
  if (/^(village|hamlet|town)$/.test(t.place || "")) return t.place === "town" ? "town" : "village";
  return null;
}
// Наскільки далеко від треку місце ще вважається «на маршруті», метри.
// Для доріг і площ (way) — більше: центр далі від краю.
const NEAR = {
  hike: { peak: 250, "mountain pass": 120, "mountain hut": 150, waterfall: 150, lake: 150, gorge: 200, cave: 80, spring: 60,
    "bathing place": 150, viewpoint: 120, "observation tower": 150, castle: 200, ruins: 150, monastery: 150, chapel: 100, church: 120,
    museum: 120, zoo: 200, "city gate": 80, monument: 80, sight: 120, restaurant: 80, "beer garden": 80, cafe: 70,
    station: 300, "cable car station": 150, village: 250, town: 300 },
  city: { station: 250, castle: 120, ruins: 80, monastery: 100, chapel: 60, church: 80, museum: 60, zoo: 150, "city gate": 60,
    monument: 50, sight: 60, square: 60, park: 120, fountain: 40, market: 60, "town hall": 60, bridge: 50, viewpoint: 80,
    waterfall: 100, lake: 120, "observation tower": 100 },
};
const WEIGHT = {
  peak: 9, "mountain hut": 9, lake: 8, waterfall: 8, gorge: 8, castle: 8, viewpoint: 7, ruins: 7, station: 7, monastery: 7,
  "cable car station": 6, restaurant: 5, "beer garden": 5, cafe: 4, church: 5, chapel: 5, museum: 6, "observation tower": 6,
  "bathing place": 5, cave: 5, sight: 6, "city gate": 6, monument: 4, square: 5, park: 4, fountain: 4, market: 4,
  "town hall": 6, bridge: 4, zoo: 5, "mountain pass": 5, spring: 3, village: 2, town: 2,
};
const KEEP_TAGS = ["name:uk", "name:en", "ele", "opening_hours", "fee", "cuisine", "operator", "seasonal", "description"];
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-zа-яіїєґäöüß0-9]/gi, "");

// Елементи OpenStreetMap → кандидати вздовж треку (без опорних точок).
export function osmCandidates(elements, track, cum, kind) {
  const near = NEAR[kind === "city" ? "city" : "hike"];
  const total = cum[cum.length - 1];
  const grid = trackGrid(track, cum);
  const box = bboxOf(track, 500);
  const out = [];
  for (const el of elements || []) {
    const t = el.tags || {};
    const k = classify(t);
    if (!k || !(k in near)) continue;
    const named = String(t.name || "").trim() !== "";
    if (!named && !["viewpoint", "waterfall", "peak", "observation tower", "bathing place", "mountain pass"].includes(k)) continue;
    let pos, lat, lng;
    if (el.bounds && k === "lake") {
      const box = { s: el.bounds.minlat, w: el.bounds.minlon, n: el.bounds.maxlat, e: el.bounds.maxlon };
      pos = nearBox(box, track, cum);
      lat = (box.s + box.n) / 2; lng = (box.w + box.e) / 2;
    } else {
      lat = el.lat != null ? el.lat : el.center && el.center.lat;
      lng = el.lon != null ? el.lon : el.center && el.center.lon;
      if (!okLatLng(lat, lng)) continue;
      const end = k === "station" || k === "village" || k === "town";
      if (!end && (lat < box.s || lat > box.n || lng < box.w || lng > box.e)) continue;
      pos = grid.near({ lat, lng }, (near[k] || 0) + 80) || { off: Infinity, km: 0 };
    }
    // Вокзал і село потрібні лише біля старту й фінішу: вокзал — як точка
    // маршруту чи підпис «старт за 400 м від вокзалу», село — лише підпис.
    if (k === "station" || k === "village" || k === "town") {
      const dS = distM(track[0], { lat, lng }), dE = distM(track[track.length - 1], { lat, lng });
      if (Math.min(dS, dE) > (k === "station" ? 800 : 1500)) continue;
      pos = { off: Math.min(pos.off, dS, dE), km: dS <= dE ? 0 : total };
    } else {
      const limit = near[k] + (el.type !== "node" && k !== "lake" ? 80 : 0);
      if (!(pos.off <= limit)) continue;
    }
    const tags = {};
    KEEP_TAGS.forEach((key) => { if (t[key]) tags[key] = String(t[key]).slice(0, 120); });
    if (t.fee === "no") delete tags.fee;
    const wiki = Boolean(t.wikidata || t.wikipedia);
    const ele = Number.isFinite(parseFloat(t.ele)) ? Math.round(parseFloat(t.ele)) : null;
    out.push({
      name: String(t.name || "").trim(), kind: k, src: "osm", lat, lng,
      km: Math.round(pos.km * 100) / 100, off: Math.round(pos.off), ele, wiki, tags, near: "",
      score: (WEIGHT[k] || 3) + (wiki ? 3 : 0) + (named ? 1 : 0) - pos.off / 100,
    });
  }
  // Однакова назва поруч (вузол і контур тієї самої церкви) — одна.
  out.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of out) {
    const dup = kept.find((x) => c.name && normName(x.name) === normName(c.name) && distM(x, c) < 400);
    if (!dup) kept.push(c);
  }
  return kept;
}

// Найближче місце потрібного типу до точки — підпис для старту й фінішу.
function nearestOf(p, cands, kinds, maxM) {
  let best = null, bd = Infinity;
  for (const c of cands) {
    if (!kinds.includes(c.kind) || !c.name) continue;
    const d = distM(p, c);
    if (d < bd && d <= maxM) { best = c; bd = d; }
  }
  return best ? `${best.name} (${best.kind}, ${Math.round(bd)} m)` : "";
}

// Усе для Claude: опорні точки (старт, фініш, найвища), позначені точки
// з файлу чи зупинки з Google Maps і місця з OpenStreetMap — до 80 штук.
// stops — зупинки, які організатор поставив сам (усі мають потрапити в маршрут).
export function buildCandidates({ track, cum, prof, stats, osm, wpts, stops, kind }) {
  const total = cum[cum.length - 1];
  const eleAt = (km) => {
    if (!prof || !prof.length || prof[0].ele == null) return null;
    let i = 0;
    while (i < prof.length - 1 && prof[i + 1].km <= km) i++;
    return prof[i].ele != null ? Math.round(prof[i].ele) : null;
  };
  const list = [];
  const own = [];
  let fromKm = 0;
  const allStops = stops || [];
  allStops.forEach((s, i) => {
    let pos = locate(s, track, cum, i === 0 ? null : fromKm);
    // Перша зупинка біля початку треку — це старт, остання біля кінця —
    // фініш (кільце може пройти через те саме місце й раніше).
    if (i === 0 && distM(s, track[0]) < 30) pos = { off: distM(s, track[0]), km: 0 };
    if (i === allStops.length - 1 && i > 0 && distM(s, track[track.length - 1]) < 30) pos = { off: distM(s, track[track.length - 1]), km: total };
    fromKm = pos.km;
    own.push({ ref: `s${i + 1}`, name: s.name || "", kind: "stop", src: "stop", lat: s.lat, lng: s.lng, km: Math.round(pos.km * 100) / 100, off: Math.round(pos.off), ele: eleAt(pos.km), wiki: false, tags: {}, near: "" });
  });
  (wpts || []).forEach((w, i) => {
    const pos = locate(w, track, cum);
    if (pos.off > 500) return;
    own.push({ ref: `w${i + 1}`, name: w.name || "", kind: w.type ? String(w.type).toLowerCase().slice(0, 30) : "wpt", src: "wpt", lat: w.lat, lng: w.lng, km: Math.round(pos.km * 100) / 100, off: Math.round(pos.off), ele: w.ele != null ? Math.round(w.ele) : eleAt(pos.km), wiki: false, tags: w.desc ? { description: String(w.desc).slice(0, 120) } : {}, near: "" });
  });
  const pois = (osm || []).slice();
  const startNear = nearestOf(track[0], pois, ["station", "cable car station", "mountain hut", "restaurant", "village", "town"], 700);
  const endPt = track[track.length - 1];
  const endNear = nearestOf(endPt, pois, ["station", "cable car station", "mountain hut", "restaurant", "village", "town"], 700);
  const coversStart = own.some((c) => c.km < 0.2);
  const coversEnd = own.some((c) => c.km > total - 0.2);
  if (!coversStart) list.push({ ref: "start", name: "", kind: "start", src: "anchor", lat: track[0].lat, lng: track[0].lng, km: 0, off: 0, ele: eleAt(0), wiki: false, tags: {}, near: startNear });
  if (stats && stats.topKm != null && kind !== "city" && stats.maxEle != null
    && stats.maxEle - Math.min(stats.startEle, stats.endEle) >= 120 && stats.topKm > 0.3 && stats.topKm < total - 0.3) {
    const p = pointAt(track, cum, stats.topKm, 1);
    list.push({ ref: "top", name: "", kind: "top", src: "anchor", lat: p.lat, lng: p.lng, km: Math.round(stats.topKm * 100) / 100, off: 0, ele: stats.maxEle, wiki: false, tags: {}, near: nearestOf(p, pois, ["peak", "mountain hut", "viewpoint", "mountain pass"], 350) });
  }
  if (!coversEnd) list.push({ ref: "end", name: "", kind: "end", src: "anchor", lat: endPt.lat, lng: endPt.lng, km: Math.round(total * 100) / 100, off: 0, ele: eleAt(total), wiki: false, tags: {}, near: endNear });
  // Села — лише для підписів старту й фінішу, у список не йдуть.
  const room = 80 - list.length - own.length;
  const picked = pois.filter((c) => c.kind !== "village" && c.kind !== "town").slice(0, Math.max(0, room))
    .map((c, i) => ({ ...c, ref: `p${i + 1}`, ele: c.ele != null ? c.ele : eleAt(c.km) }));
  return list.concat(own, picked).sort((a, b) => a.km - b.km);
}

// ── 4. Час ───────────────────────────────────────────────────────────
// Години ходу без зупинок (DIN 33466; місто — 3,5 км/год, вело — 14 км/год).
export function walkHours(km, up, down, kind) {
  if (kind === "bike") return km / 14 + (up || 0) / 600;
  const h = km / (kind === "city" ? 3.5 : 4);
  const v = (up || 0) / 300 + (down || 0) / 500;
  return kind === "city" ? h + v / 2 : Math.max(h, v) + Math.min(h, v) / 2;
}
const cumAt = (prof, arr, km) => {
  if (!arr) return 0;
  let lo = 0, hi = prof.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (prof[mid].km <= km) lo = mid; else hi = mid - 1; }
  return arr[lo] || 0;
};
const toMin = (hm) => { const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toHM = (min) => { const x = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
const round5 = (min) => Math.round(min / 5) * 5;

// Час прибуття на кожну точку (points відсортовані за km): старт + хід
// по відрізку + зупинки на попередніх точках. Без часу старту — порожньо.
export function pointTimes(points, prof, climb, startHM, kind) {
  const start = toMin(startHM);
  let walk = 0, stops = 0;
  const times = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const a = points[i - 1].km, b = points[i].km;
      const up = climb ? cumAt(prof, climb.cumUp, b) - cumAt(prof, climb.cumUp, a) : 0;
      const down = climb ? cumAt(prof, climb.cumDown, b) - cumAt(prof, climb.cumDown, a) : 0;
      walk += walkHours(Math.max(0, b - a), up, down, kind) * 60;
      stops += points[i - 1].stopMin || 0;
    }
    times.push(start == null ? "" : toHM(round5(start + walk + stops)));
  }
  const lastStop = points.length ? points[points.length - 1].stopMin || 0 : 0;
  return { times, walkMin: walk, stopMin: stops + lastStop };
}
// Тривалість для поля «Тривалість»: «4–5 год», «2,5–3,5 год».
export function durationRange(hours) {
  if (!(hours > 0)) return "";
  const lo = Math.max(0.5, Math.floor(hours * 2) / 2);
  const hi = Math.ceil(hours * 2) / 2 + 0.5;
  const f = (x) => String(x).replace(".", ",");
  return `${f(lo)}–${f(Math.max(hi, lo + 0.5))} год`;
}
// Старт: прибуття останнього поїзда першого відправлення + 10 хв,
// округлене вгору до 5 хв. Немає поїздів — порожньо (організатор впише).
export function startFromTrains(journeys) {
  const legs = ((journeys && journeys[0] && journeys[0].legs) || []).filter((l) => l && String(l.toTime || "").trim());
  const last = legs[legs.length - 1];
  const m = toMin(String((last && last.toTime) || "").trim().padStart(5, "0"));
  return m == null ? "" : toHM(Math.ceil((m + 10) / 5) * 5);
}

// ── Зупинки з Google Maps → трек ─────────────────────────────────────
// Пішохідний маршрут між зупинками — з OSRM на серверах FOSSGIS (той самий,
// що на openstreetmap.org). Не вийшло — прямі відрізки (straight: true).
export async function routeThroughStops(stops, profile, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const coords = stops.map((s) => `${s.lng.toFixed(6)},${s.lat.toFixed(6)}`).join(";");
  const base = profile === "bike"
    ? "https://routing.openstreetmap.de/routed-bike/route/v1/bike/"
    : "https://routing.openstreetmap.de/routed-foot/route/v1/foot/";
  try {
    const r = await doFetch(`${base}${coords}?overview=full&geometries=geojson&steps=false`, { signal: timeoutSignal(20000) });
    if (r.ok) {
      const j = await r.json();
      const line = j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates;
      if (Array.isArray(line) && line.length >= 2) {
        const track = line.map((c) => ({ lat: c[1], lng: c[0], ele: null })).filter((p) => okLatLng(p.lat, p.lng));
        if (track.length >= 2) return { track, straight: false };
      }
    }
  } catch { /* далі прямі відрізки */ }
  // Прямі відрізки, через кожні ~50 м — щоб місця поруч знаходились так само.
  const track = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const n = Math.max(1, Math.round(distM(a, b) / 50));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) track.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lng: a.lng + ((b.lng - a.lng) * k) / n, ele: null });
  }
  return { track, straight: true };
}
