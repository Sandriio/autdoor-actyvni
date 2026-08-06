// Проксі до сервісу розкладу Deutsche Bahn.
// Запит іде з сервера Vercel, а не з телефона користувача — так немає
// блокувань з боку браузера й менше шансів упертися в ліміти.
const UPSTREAM = "https://v6.db.transport.rest";
const ALLOWED = new Set(["/locations", "/journeys"]);

export default async function handler(req, res) {
  const { path, ...rest } = req.query || {};
  if (!path || !ALLOWED.has(path)) {
    res.status(400).json({ error: "bad path" });
    return;
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) {
    params.set(k, Array.isArray(v) ? v[0] : v);
  }
  try {
    const r = await fetch(`${UPSTREAM}${path}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "autdoor-actyvni community trips app",
      },
    });
    const body = await r.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Коротке кешування: однакові запити не б'ють по сервісу повторно.
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
