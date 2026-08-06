// Серверна функція Vercel: переклад через DeepL.
// Ключ DeepL зберігається в змінній середовища DEEPL_API_KEY
// (Vercel → Project → Settings → Environment Variables).
// Якщо ключа немає — функція відповідає, що переклад вимкнено,
// і застосунок просто збереже вміст українською.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const key = process.env.DEEPL_API_KEY;
  if (!key) {
    res.status(200).json({ translations: null, disabled: true });
    return;
  }
  const { texts, target } = req.body || {};
  if (!Array.isArray(texts) || texts.length === 0 || !target) {
    res.status(400).json({ error: "bad request" });
    return;
  }
  try {
    const params = new URLSearchParams();
    texts.forEach((t) => params.append("text", String(t)));
    params.append("source_lang", "UK");
    params.append("target_lang", target === "RU" ? "RU" : "EN");
    // Безкоштовні ключі DeepL (закінчуються на ":fx") працюють саме з цим хостом.
    const r = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!r.ok) {
      res.status(502).json({ error: "deepl " + r.status });
      return;
    }
    const j = await r.json();
    res.status(200).json({ translations: (j.translations || []).map((t) => t.text) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
