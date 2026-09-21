// ═══════════════════════════════════════════════════════════════════
// Видалення файлу, доданого в застосунку
//
// ЧОМУ ЧЕРЕЗ СЕРВЕР
// Щоб файл справді звільнив місце у сховищі, його треба видаляти через
// API сховища — видалення рядка з таблиці через SQL залишає сам файл
// займати місце назавжди. А для API потрібен дозвіл на видалення. Дати
// такий дозвіл застосунку означало б дозволити будь-кому видалити
// будь-який файл напряму, в обхід будь-якої перевірки. Тому дозвіл має
// лише цей сервер: він спершу перевіряє право, а тоді видаляє своїм
// ключем.
//
// ХТО МОЖЕ ВИДАЛЯТИ
//  • організатор — будь-який файл, за PIN (перевірка через check_pin,
//    ту саму функцію, що пускає в режим організатора);
//  • учасник — лише своє: пристрій, що завантажив файл, надсилає свій
//    ключ, а сервер порівнює його відбиток SHA-256 зі збереженим.
//
// Архів на Google Диску тут не видаляється: застосунок має до нього
// доступ лише на читання.
//
// ЗМІННІ СЕРЕДОВИЩА (Vercel → Environment Variables)
//   SUPABASE_URL               — уже є
//   SUPABASE_SERVICE_ROLE_KEY  — ПОТРІБНО ДОДАТИ. Лише сюди, ніколи в код.
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

const BUCKET = "photos";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "лише POST" });
    return;
  }

  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) {
    // Найімовірніша причина збою після встановлення: ключ не додано у
    // Vercel або після додавання не зроблено Redeploy.
    res.status(500).json({ error: "сервер не налаштований: немає SUPABASE_SERVICE_ROLE_KEY" });
    return;
  }

  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  const id = String(body.id || "");
  if (!id) { res.status(400).json({ error: "не вказано файл" }); return; }

  const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  try {
    // 1. Знайти запис
    const r = await fetch(`${URL}/rest/v1/uploads?id=eq.${encodeURIComponent(id)}&select=id,url,owner_hash`, { headers: h });
    const rows = r.ok ? await r.json() : [];
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) { res.status(404).json({ error: "файл не знайдено" }); return; }

    // 2. Перевірити право
    let allowed = false;
    if (body.pin) {
      const c = await fetch(`${URL}/rest/v1/rpc/check_pin`, {
        method: "POST", headers: h, body: JSON.stringify({ pin: String(body.pin) }),
      });
      allowed = c.ok && (await c.json()) === true;
    } else if (body.token) {
      const hash = crypto.createHash("sha256").update(String(body.token)).digest("hex");
      // Порівняння за сталий час: інакше за швидкістю відповіді можна
      // було б вгадувати відбиток по одному знаку.
      allowed = Boolean(row.owner_hash) && hash.length === row.owner_hash.length &&
        crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.owner_hash));
    }
    if (!allowed) { res.status(403).json({ error: "немає права видалити цей файл" }); return; }

    // 3. Видалити сам файл — але лише якщо на нього не посилається інший
    //    запис. Таблицю завантажень може доповнити будь-хто, тож хтось
    //    міг би створити власний запис із посиланням на чуже фото, а
    //    потім «видалити своє» — і разом стерти чужий файл. Ця перевірка
    //    робить такий трюк марним: зникне лише підроблений запис.
    const marker = `/object/public/${BUCKET}/`;
    const name = String(row.url || "").split(marker)[1] || "";
    const o = await fetch(
      `${URL}/rest/v1/uploads?url=eq.${encodeURIComponent(row.url)}&id=neq.${encodeURIComponent(id)}&select=id`,
      { headers: h });
    const others = o.ok ? await o.json() : [];
    if (name && Array.isArray(others) && others.length === 0) {
      const d = await fetch(`${URL}/storage/v1/object/${BUCKET}`, {
        method: "DELETE", headers: h, body: JSON.stringify({ prefixes: [name] }),
      });
      if (!d.ok) {
        res.status(502).json({ error: `сховище відмовило: ${(await d.text()).slice(0, 120)}` });
        return;
      }
    }

    // 4. Прибрати запис зі списку
    const del = await fetch(`${URL}/rest/v1/uploads?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: h });
    if (!del.ok) {
      res.status(502).json({ error: `база відмовила: ${(await del.text()).slice(0, 120)}` });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 160) });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
