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
//  • організатор — будь-який файл, за PIN (перевірка через check_pin);
//  • учасник — лише своє: пристрій, що завантажив файл, надсилає свій
//    ключ, а сервер порівнює його відбиток SHA-256 зі збереженим.
//
// ПЕРЕВІРКА НАЛАШТУВАНЬ
// Відкрий цю адресу в браузері (звичайний перехід, без нічого в кінці):
//   https://<сайт>/api/delete-upload
// Сервер покаже, чи є ключ, чи це саме ключ service_role, і чи бачить
// він таблицю. Значень ключів не показує — лише так/ні і тип.
//
// ЗМІННІ СЕРЕДОВИЩА (Vercel → проєкт → Environment Variables)
//   SUPABASE_URL               — уже є
//   SUPABASE_SERVICE_ROLE_KEY  — саме service_role, НЕ anon
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

const BUCKET = "photos";

// Який це ключ — за полем role усередині нього. Сам ключ не
// розкривається: повертається лише слово service_role або anon.
// Навіщо: у Supabase обидва старі ключі стоять поруч і обидва
// починаються з «eyJ», тож їх легко переплутати. З ключем anon
// читати фото можна, а видаляти — ні, і база мовчки нічого не робить.
function keyKind(key) {
  if (!key) return "немає";
  if (key.startsWith("sb_secret_")) return "секретний (новий формат)";
  if (key.startsWith("sb_publishable_")) return "ПУБЛІЧНИЙ — не той ключ";
  const parts = key.split(".");
  if (parts.length !== 3) return "невідомий формат";
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (json.role === "service_role") return "service_role";
    if (json.role === "anon") return "anon — НЕ ТОЙ КЛЮЧ";
    return `невідома роль: ${String(json.role || "?")}`;
  } catch {
    return "невідомий формат";
  }
}

export default async function handler(req, res) {
  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const h = KEY ? { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } : {};

  // ── Перевірка налаштувань: відкрий адресу в браузері ─────────────
  if (req.method === "GET") {
    const report = {
      "адреса бази": Boolean(URL),
      "ключ": keyKind(KEY),
    };
    if (URL && KEY) {
      try {
        const r = await fetch(`${URL}/rest/v1/uploads?select=id,owner_hash&limit=1000`, { headers: h });
        report["таблиця завантажень"] = r.ok ? "видно" : `помилка ${r.status}`;
        if (r.ok) {
          const rows = await r.json();
          report["файлів у таблиці"] = Array.isArray(rows) ? rows.length : "?";
          report["поле owner_hash"] = "є";
        } else {
          const txt = await r.text();
          if (/owner_hash/.test(txt)) report["поле owner_hash"] = "НЕМАЄ — не виконано supabase-v121.sql";
        }
      } catch (e) {
        report["таблиця завантажень"] = `недоступна: ${String((e && e.message) || e).slice(0, 80)}`;
      }
    }
    res.status(200).json(report);
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "лише POST" }); return; }

  if (!URL || !KEY) {
    res.status(500).json({ error: "сервер не налаштований: немає SUPABASE_SERVICE_ROLE_KEY" });
    return;
  }
  // Ключ не того типу — кажемо одразу й прямо, а не після тихої невдачі.
  const kind = keyKind(KEY);
  if (kind !== "service_role" && !kind.startsWith("секретний")) {
    res.status(500).json({ error: `у Vercel вставлено не той ключ: ${kind}. Потрібен service_role.` });
    return;
  }

  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  const id = String(body.id || "");
  if (!id) { res.status(400).json({ error: "не вказано файл" }); return; }

  try {
    // 1. Знайти запис
    const r = await fetch(`${URL}/rest/v1/uploads?id=eq.${encodeURIComponent(id)}&select=id,url,owner_hash`, { headers: h });
    if (!r.ok) {
      res.status(502).json({ error: `база відповіла ${r.status}: ${(await r.text()).slice(0, 120)}` });
      return;
    }
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) { res.status(404).json({ error: "файл не знайдено — можливо, його вже видалили" }); return; }

    // 2. Перевірити право
    let allowed = false;
    if (body.pin) {
      const c = await fetch(`${URL}/rest/v1/rpc/check_pin`, {
        method: "POST", headers: h, body: JSON.stringify({ pin: String(body.pin) }),
      });
      allowed = c.ok && (await c.json()) === true;
    } else if (body.token) {
      const hash = crypto.createHash("sha256").update(String(body.token)).digest("hex");
      allowed = Boolean(row.owner_hash) && hash.length === row.owner_hash.length &&
        crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.owner_hash));
    }
    if (!allowed) {
      res.status(403).json({ error: row.owner_hash
        ? "немає права видалити цей файл"
        : "цей файл додано до оновлення, тому видалити його може лише організатор" });
      return;
    }

    // 3. Чи посилається на той самий файл ще хтось. Таблицю завантажень
    //    може доповнити будь-хто, тож хтось міг би створити власний запис
    //    із посиланням на чуже фото, а потім «видалити своє» — і разом
    //    стерти чужий файл. Якщо інші посилання є, файл не чіпаємо.
    const o = await fetch(
      `${URL}/rest/v1/uploads?url=eq.${encodeURIComponent(row.url)}&id=neq.${encodeURIComponent(id)}&select=id`,
      { headers: h });
    const others = o.ok ? await o.json() : [];

    // 4. Прибрати запис — і ПЕРЕВІРИТИ, що він справді зник. Коли база не
    //    має права видаляти, вона не повертає помилку, а тихо видаляє
    //    нуль рядків і відповідає «готово». Саме через це видалення
    //    раніше «проходило», а фото лишалося на місці.
    const del = await fetch(`${URL}/rest/v1/uploads?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { ...h, Prefer: "return=representation" },
    });
    if (!del.ok) {
      res.status(502).json({ error: `база відмовила: ${(await del.text()).slice(0, 120)}` });
      return;
    }
    const gone = await del.json().catch(() => []);
    if (!Array.isArray(gone) || gone.length === 0) {
      res.status(500).json({ error: "база нічого не видалила: у ключа немає права. Перевір, що в Vercel саме service_role, а не anon." });
      return;
    }

    // 5. Видалити сам файл зі сховища, щоб звільнити місце. Робимо ПІСЛЯ
    //    запису: якщо тут щось не вдасться, фото вже зникло зі списку, а
    //    лише місце не звільнилося. Навпаки було б гірше — лишився б
    //    запис на неіснуючий файл, тобто порожня рамка в галереї.
    const marker = `/object/public/${BUCKET}/`;
    const name = String(row.url || "").split(marker)[1] || "";
    let warning = "";
    if (name && Array.isArray(others) && others.length === 0) {
      const d = await fetch(`${URL}/storage/v1/object/${BUCKET}`, {
        method: "DELETE", headers: h, body: JSON.stringify({ prefixes: [name] }),
      });
      const removed = d.ok ? await d.json().catch(() => []) : [];
      if (!d.ok || !Array.isArray(removed) || removed.length === 0) {
        warning = "фото прибрано зі списку, але файл у сховищі лишився";
      }
    }

    res.status(200).json(warning ? { ok: true, warning } : { ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 160) });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
