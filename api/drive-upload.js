// ═══ Tropa Club · api/drive-upload.js · ВЕРСІЯ u2 ═══
// ═══════════════════════════════════════════════════════════════════
// Відео з застосунку — прямо в альбом поїздки на Google Диску
//
// НАВІЩО
// Сховище Supabase на безкоштовному тарифі приймає файл до 50 МБ — це
// пів хвилини відео з iPhone. Платний тариф дорогий. Google Диск
// організатора — і так архів усіх поїздок, на ньому 15 ГБ безкоштовно
// (далі 100 ГБ — €1,99 на місяць), і файл там може важити гігабайти.
//
// ЯК ПРАЦЮЄ
//  1. Застосунок: POST { action: "start", folderId, name, type, size, owner }.
//     Сервер перевіряє запит і просить «міст» (Apps Script в акаунті
//     організатора) відкрити на Диску завантаження в теку альбому. Міст
//     повертає одноразовий квиток, сервер віддає його застосунку разом з
//     адресою мосту.
//  2. u2 (міст b5): разом із квитком сервер віддає застосунку адресу
//     завантаження на самому Диску («direct»). Телефон шле відео шматками
//     по 8 МБ ПРЯМО туди — зі швидкістю свого інтернету. Міст відкриває
//     це завантаження з адресою застосунку (Origin), бо інакше браузер
//     до Диска не пустить. Не вийшло напряму — шматки по 4 МБ ідуть
//     мосту з квитком, як у u1 (повільно: Apps Script ~0,14 МБ/с).
//  3. Застосунок: POST { action: "finish", ticket }. Сервер питає в мосту
//     номер готового файлу (міст b5 сам питає про нього Диск) й записує
//     його в таблицю завантажень — з відбитком ключа пристрою, щоб автор
//     міг видалити своє відео.
//  • GET — перевірка: чи налаштовано, яка версія мосту й чи відео йде
//    напряму (потрібен b5) чи лише через міст (b4).
//
// ЗАХИСТ
//  • Секретне слово мосту живе лише тут, на сервері, у змінних Vercel.
//  • Номер файлу на Диску береться з відповіді самого Диска (через міст),
//    а не від телефона — підсунути чужий файл не вийде.
//  • Міст кладе файли лише в теку архіву й підписує їх «tropa-upload:<запис>»,
//    тож видалення (api/delete-upload.js) прибирає саме їх.
//
// ЗМІННІ СЕРЕДОВИЩА — ті самі, що вже є: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, DRIVE_BRIDGE_URL, DRIVE_BRIDGE_SECRET.
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 30 };

export const MAX_UPLOAD = 1024 * 1024 * 1024;   // 1 ГБ — так само в мості

// Адреса застосунку, з якої телефон шле відео напряму на Диск. Береться з
// заголовка Origin самого запиту (його ставить браузер, підробити з
// браузера не можна); лише https або localhost для перевірок.
export function originOf(req) {
  const o = String((req.headers && (req.headers.origin || req.headers.Origin)) || "").trim();
  if (/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o)) return o;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(o)) return o;
  return "";
}
const bridgeVersion = (v) => (/^b(\d+)$/.test(String(v)) ? Number(String(v).slice(1)) : 0);

const env = () => ({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  bridge: process.env.DRIVE_BRIDGE_URL,
  secret: process.env.DRIVE_BRIDGE_SECRET,
});

async function bridgeCall(E, body) {
  const r = await fetch(E.bridge, {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow",
    body: JSON.stringify({ ...body, secret: E.secret }),
    signal: AbortSignal.timeout(25000),
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* не JSON — найчастіше сторінка входу Google */ }
  if (!j) throw new Error(`міст відповів не JSON (${r.status})`);
  if (j.error === "невідома дія") throw new Error("міст старої версії — потрібен b4");
  return j;
}

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);

export default async function handler(req, res) {
  const E = env();
  if (req.method === "GET") {
    const report = { "версія": "u2", "налаштовано": Boolean(E.url && E.key && E.bridge && E.secret) };
    // Адресу мосту тепер бачать телефони (шматки відео йдуть прямо туди),
    // тож решту дій мосту береже лише секретне слово. Показуємо лише його
    // довжину: коротке — варто замінити (і в Vercel, і в Script properties).
    if (E.secret) report["секретне слово"] = E.secret.length >= 24 ? `${E.secret.length} знаків — добре` : `${E.secret.length} знаків — закоротке, заміни на 30+ випадкових`;
    if (E.bridge && E.secret) {
      try {
        const j = await bridgeCall(E, { action: "ping" });
        report["міст"] = j.ok ? `працює · ${j.version}` : `помилка: ${j.error}`;
        const v = j.ok ? bridgeVersion(j.version) : 0;
        report["відео прямо на Диск"] = v >= 4 ? "так" : "ні — онови міст до b5";
        report["швидке відео (з телефона напряму)"] = v >= 5 ? "так" : v === 4
          ? "ні — зараз через міст, повільно: онови міст до b5" : "ні — онови міст до b5";
      } catch (e) {
        report["міст"] = `не відповідає: ${String((e && e.message) || e).slice(0, 120)}`;
      }
    }
    res.status(200).json(report);
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "лише POST" }); return; }
  if (!E.url || !E.key || !E.bridge || !E.secret) {
    res.status(500).json({ error: "сервер не налаштований: немає змінних мосту або бази у Vercel" });
    return;
  }
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});

  try {
    if (body.action === "start") {
      const folderId = clean(body.folderId, 100);
      const type = clean(body.type, 80).toLowerCase();
      const size = Math.floor(Number(body.size) || 0);
      const owner = clean(body.owner, 64).toLowerCase();
      const name = clean(body.name, 120) || "video.mp4";
      if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId)) { res.status(400).json({ error: "не та тека альбому" }); return; }
      if (!/^video\/[a-z0-9.+-]+$/.test(type)) { res.status(400).json({ error: "це не відео", code: "type" }); return; }
      if (size <= 0 || size > MAX_UPLOAD) { res.status(400).json({ error: "відео до 1 ГБ", code: "size" }); return; }
      if (!/^[0-9a-f]{64}$/.test(owner)) { res.status(400).json({ error: "немає ключа пристрою" }); return; }
      const uploadId = `u${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      const origin = originOf(req);
      const j = await bridgeCall(E, { action: "upstart", uploadId, folderId, name, type, size, owner, origin });
      if (!j.ok || !j.ticket) { res.status(502).json({ error: j.error || "міст не відкрив завантаження", code: j.code || "bridge" }); return; }
      // Адреса завантаження на Диску — лише якщо міст відкрив його з адресою
      // застосунку (b5) і це справді адреса Диска.
      const direct = origin && /^https:\/\/([a-z0-9-]+\.)*googleapis\.com\/upload\//.test(String(j.session || ""))
        ? String(j.session) : "";
      res.status(200).json({ ok: true, ticket: j.ticket, chunk: j.chunk, bridge: E.bridge, uploadId, direct });
      return;
    }

    if (body.action === "finish") {
      const ticket = clean(body.ticket, 80).replace(/[^a-f0-9]/g, "");
      if (ticket.length < 32) { res.status(400).json({ error: "немає квитка" }); return; }
      const j = await bridgeCall(E, { action: "upinfo", ticket });
      if (!j.ok) {
        // 404 — квитка вже немає (застарів) і чекати нема чого; решта —
        // тимчасовий збій, застосунок спитає ще раз пізніше.
        const gone = j.code === "ticket" || j.code === "expired";
        res.status(gone ? 404 : 502).json({ error: j.error || "завантаження не знайдено", code: j.code || "ticket" });
        return;
      }
      if (!j.done || !j.fileId) { res.status(409).json({ error: "відео ще не завантажено до кінця", code: "notdone" }); return; }
      const row = {
        id: j.uploadId, folder_id: j.folderId, url: `drive:${j.fileId}`,
        kind: String(j.type || "").startsWith("image/") ? "image" : "video",
        name: clean(j.name, 120), owner_hash: j.owner || null, drive_id: j.fileId,
      };
      // Повтор «finish» (зв'язок обірвався після запису) не має робити
      // другого рядка — той самий номер запису просто не вставиться вдруге.
      const r = await fetch(`${E.url}/rest/v1/uploads?on_conflict=id`, {
        method: "POST",
        headers: { apikey: E.key, Authorization: `Bearer ${E.key}`, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
      if (!r.ok) { res.status(502).json({ error: `база відмовила: ${(await r.text()).slice(0, 140)}` }); return; }
      res.status(200).json({ ok: true, id: row.id, fileId: j.fileId });
      return;
    }

    res.status(400).json({ error: "невідома дія" });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e).slice(0, 160) });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
