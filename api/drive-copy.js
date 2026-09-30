// ═══ Tropa Club · api/drive-copy.js · ВЕРСІЯ d2 ═══
// ═══════════════════════════════════════════════════════════════════
// Копія завантажених фото й відео на Google Диск
//
// НАВІЩО
// Фото, додане в застосунку, лягає у сховище Supabase. Google Диск —
// архів організатора — про нього не знав: фото з Диска видно в
// застосунку, а навпаки ні. Сам сервер записати на особистий Диск не може:
// Google дає це лише самому власникові Диска. Тому запис робить маленький
// скрипт у Google-акаунті організатора («міст», Google Apps Script), а цей
// сервер лише каже йому, що й куди скопіювати.
//
// ЯК ПРАЦЮЄ
//  • POST { id }            — скопіювати одне завантаження (застосунок
//                              викликає одразу після завантаження);
//  • POST { backfill, pin } — докопіювати пропущене, кілька штук за раз
//                              (застосунок організатора робить це сам,
//                              коли відкриваєш «Медіаконтент»);
//  • GET                    — перевірка: чи налаштовано, чи відповідає міст,
//                              скільки ще не скопійовано. Відкрий адресу
//                              <сайт>/api/drive-copy у браузері.
//
// СТАН КОПІЇ (поле uploads.drive_id)
//   порожньо          — ще не копіювали;
//   pending:<час>     — копіюється саме зараз;
//   retry:<час>       — спроба не вдалася, повторимо не раніше ніж за 10 хв;
//   skip:<причина>    — копіювати не треба: файлу чи альбому вже немає,
//                        чужа адреса, двійник іншого запису;
//   будь-що інше      — номер файлу-копії на Google Диску.
// Невдалі спроби стають у кінець черги, тож один «важкий» файл не
// зупиняє копіювання всіх інших.
//
// ЗАХИСТ
//  • Копіюються лише файли з нашого сховища — чужу адресу підсунути не
//    вийде, навіть якщо хтось допише запис у таблицю.
//  • Поле drive_id ставить лише цей сервер (у базі воно закрите для
//    запису з телефонів — див. supabase-v131.sql).
//  • Кожна копія «бронюється» в базі перед копіюванням, тож два виклики
//    одночасно не створять на Диску двох однакових файлів. А якщо
//    відповідь мосту загубилась, міст при повторі знайде свою першу копію
//    за підписом і не робитиме другої.
//
// ЗМІННІ СЕРЕДОВИЩА (Vercel → Settings → Environment Variables)
//   SUPABASE_URL               — уже є
//   SUPABASE_SERVICE_ROLE_KEY  — уже є (ним видаляються завантаження)
//   DRIVE_BRIDGE_URL           — адреса мосту (…/exec) з Apps Script
//   DRIVE_BRIDGE_SECRET        — те саме слово, що SECRET у скрипті
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

// Коренева тека архіву — та сама, що показує вкладка «Медіаконтент».
const ROOT_FOLDER = "17zaBzXwcsTBnjvf7ncOlzltQNaVTGOyi";
const BUCKET = "photos";
const STALE_MS = 10 * 60 * 1000;   // через стільки зависла «бронь» чи невдала спроба йде на повтор
const BATCH_BUDGET_MS = 25 * 1000; // новий файл у заході догону починаємо лише в межах цього часу
const BATCH_SIZE = 8;

const env = () => ({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  bridge: process.env.DRIVE_BRIDGE_URL,
  secret: process.env.DRIVE_BRIDGE_SECRET,
});
const hdr = (key, extra) => ({ apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(extra || {}) });

// ── стани поля drive_id ──
const stamp = (v) => Number(String(v).split(":")[1]) || 0;
const isOpen = (v) => !v || /^(pending|retry):/.test(v);          // ще не скопійовано
const isReady = (v) => !v || (isOpen(v) && Date.now() - stamp(v) > STALE_MS);  // можна братися

async function bridgeCall(E, payload) {
  const r = await fetch(E.bridge, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, secret: E.secret }),
    redirect: "follow",
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* не JSON — найчастіше сторінка входу Google */ }
  if (!j) {
    throw new Error(/accounts\.google|ServiceLogin|<html/i.test(txt)
      ? "міст просить увійти в Google: у налаштуваннях розгортання має бути «Who has access: Anyone»"
      : `міст відповів не JSON (${r.status})`);
  }
  if (j.error) {
    const err = new Error(`міст: ${j.error}`);
    err.code = j.code || "";
    throw err;
  }
  return j;
}

// Ім'я файлу на Диску: як у людини на телефоні, але з правильним
// розширенням. Фото ми перекодовуємо в JPEG, тож IMG_1234.HEIC стає
// IMG_1234.jpg — інакше Диск вважав би файл пошкодженим.
function driveName(row) {
  const ext = (String(row.url).split("?")[0].split(".").pop() || "jpg").toLowerCase();
  let base = String(row.name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim();
  if (!base) base = `${row.kind === "video" ? "video" : "photo"}-${row.id}`;
  return `${base.slice(0, 100)}.${ext}`;
}

async function getRow(E, id) {
  const r = await fetch(`${E.url}/rest/v1/uploads?id=eq.${encodeURIComponent(id)}&select=id,folder_id,url,kind,name,drive_id,created_at`, { headers: hdr(E.key) });
  if (!r.ok) throw new Error(`база відповіла ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

// Умовне оновлення drive_id: спрацьовує, лише якщо поле досі має
// очікуване значення. Повертає true, якщо рядок справді змінено.
async function setDriveId(E, id, from, to) {
  const cond = from == null ? "drive_id=is.null" : `drive_id=eq.${encodeURIComponent(from)}`;
  const r = await fetch(`${E.url}/rest/v1/uploads?id=eq.${encodeURIComponent(id)}&${cond}`, {
    method: "PATCH",
    headers: hdr(E.key, { Prefer: "return=representation" }),
    body: JSON.stringify({ drive_id: to }),
  });
  if (!r.ok) throw new Error(`база відмовила: ${(await r.text()).slice(0, 120)}`);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function copyOne(E, id) {
  const row = await getRow(E, id);
  if (!row) return { id, skipped: "запису немає" };
  const cur = row.drive_id || null;
  if (!isOpen(cur)) return { id, already: cur };
  if (!isReady(cur)) return { id, skipped: "уже копіюється або чекає повтору" };

  // Те, що не скопіюється ніколи, позначаємо, щоб не брати знову й знову.
  const skip = async (why, text) => {
    await setDriveId(E, id, cur, `skip:${why}`).catch(() => {});
    return { id, skipped: text };
  };
  const prefix = `${E.url}/storage/v1/object/public/${BUCKET}/`;
  if (!String(row.url || "").startsWith(prefix)) return skip("url", "адреса не з нашого сховища");
  if (row.kind !== "image" && row.kind !== "video") return skip("kind", "не фото й не відео");
  // Якщо той самий файл має ще один запис, копіюємо лише найперший:
  // інакше підкинутий «двійник» запису дав би на Диску другу копію.
  const d = await fetch(`${E.url}/rest/v1/uploads?url=eq.${encodeURIComponent(row.url)}&select=id&order=created_at.asc,id.asc&limit=1`, { headers: hdr(E.key) });
  const first = d.ok ? (await d.json())[0] : null;
  if (first && first.id !== row.id) return skip("dup", "той самий файл уже є під іншим записом");

  // Бронюємо: із теперішнього стану — у «копіюється зараз».
  const mark = `pending:${Date.now()}`;
  if (!(await setDriveId(E, id, cur, mark))) return { id, skipped: "уже копіюється" };

  const folderId = !row.folder_id || row.folder_id === "root" ? ROOT_FOLDER : row.folder_id;
  let res;
  try {
    res = await bridgeCall(E, { action: "copy", url: row.url, name: driveName(row), folderId, uploadId: row.id });
  } catch (e) {
    const code = e && e.code;
    if (code === "gone" || code === "folder" || code === "url") {
      await setDriveId(E, id, mark, `skip:${code}`).catch(() => {});
      return { id, skipped: String(e.message || e).slice(0, 200) };
    }
    await setDriveId(E, id, mark, `retry:${Date.now()}`).catch(() => {});   // спробуємо пізніше
    return { id, error: String((e && e.message) || e).slice(0, 200) };
  }
  // Записуємо, де лежить копія.
  const saved = await setDriveId(E, id, mark, res.id).catch(() => false);
  if (!saved) {
    // Запису вже немає — людина встигла видалити фото, поки воно
    // копіювалось: прибираємо щойно створену копію, щоб на Диску не
    // лишилось «сироти». Якщо ж запис є (просто база не відповіла), бронь
    // згодом застаріє, а повтор знайде цю копію за підписом.
    const still = await getRow(E, id).catch(() => true);
    if (!still) {
      await bridgeCall(E, { action: "trash", id: res.id, uploadId: row.id }).catch(() => {});
      return { id, skipped: "запис видалили під час копіювання" };
    }
    return { id, error: "не вдалося записати номер копії — повторимо пізніше" };
  }
  return { id, copied: res.id, reused: Boolean(res.reused) };
}

async function pinOk(E, pin) {
  const r = await fetch(`${E.url}/rest/v1/rpc/check_pin`, { method: "POST", headers: hdr(E.key), body: JSON.stringify({ pin: String(pin || "") }) });
  return r.ok && (await r.json()) === true;
}

// Усе, що ще не скопійоване: порожні, «броні» й невдалі спроби.
async function openRows(E) {
  const r = await fetch(
    `${E.url}/rest/v1/uploads?or=(drive_id.is.null,drive_id.like.pending:*,drive_id.like.retry:*)&select=id,drive_id&order=created_at.asc,id.asc&limit=1000`,
    { headers: hdr(E.key) });
  if (!r.ok) throw new Error(`база відповіла ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// Черга: спершу нові (найстаріші першими), потім зависли «броні», в
// самому кінці — невдалі спроби.
function readyFirst(rows, n) {
  const rank = (v) => (!v ? 0 : v.startsWith("pending:") ? 1 : 2);
  return rows
    .filter((x) => isReady(x.drive_id))
    .sort((a, b) => rank(a.drive_id) - rank(b.drive_id) || (rank(a.drive_id) ? stamp(a.drive_id) - stamp(b.drive_id) : 0))
    .slice(0, n);
}

export default async function handler(req, res) {
  const E = env();
  const configured = Boolean(E.url && E.key && E.bridge && E.secret);

  // ── Перевірка налаштувань ────────────────────────────────────────
  if (req.method === "GET") {
    const report = {
      "версія": "d2",
      "налаштовано": configured,
      "бракує змінних": ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DRIVE_BRIDGE_URL", "DRIVE_BRIDGE_SECRET"]
        .filter((k) => !process.env[k]),
    };
    if (configured) {
      try {
        const p = await bridgeCall(E, { action: "ping" });
        report["міст"] = `працює · ${p.version || "b1"} · тека «${p.folder || "?"}»`;
      } catch (e) {
        report["міст"] = `не відповідає: ${String((e && e.message) || e).slice(0, 160)}`;
      }
      try {
        report["чекають копіювання"] = (await openRows(E)).length;
        const s = await fetch(`${E.url}/rest/v1/uploads?drive_id=like.skip:*&select=id`, { headers: hdr(E.key) });
        if (s.ok) report["не копіюються (файлу чи альбому вже немає)"] = (await s.json()).length;
      } catch (e) {
        report["чекають копіювання"] = `не вдалося порахувати: ${String((e && e.message) || e).slice(0, 120)}`;
      }
    }
    res.status(200).json(report);
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "лише POST або GET" }); return; }
  if (!configured) { res.status(503).json({ error: "копіювання на Google Диск ще не налаштоване" }); return; }

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});

  try {
    // ── Догін: скопіювати те, що ще не на Диску ─────────────────────
    if (body.backfill) {
      if (!(await pinOk(E, body.pin))) { res.status(403).json({ error: "невірний PIN" }); return; }
      const started = Date.now();
      let copied = 0, error = "";
      for (const x of readyFirst(await openRows(E), BATCH_SIZE)) {
        if (Date.now() - started > BATCH_BUDGET_MS) break;
        const r = await copyOne(E, x.id);
        if (r.copied) copied++;
        else if (r.error) { error = r.error; break; }   // міст збоїть — не мучимо його далі
      }
      const left = (await openRows(E)).length;
      res.status(200).json({ copied, left, error });
      return;
    }

    // ── Одне завантаження ───────────────────────────────────────────
    const id = String(body.id || "");
    if (!id) { res.status(400).json({ error: "не вказано файл" }); return; }
    const r = await copyOne(E, id);
    res.status(r.error ? 502 : 200).json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
}
