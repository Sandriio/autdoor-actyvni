// ═══════════════════════════════════════════════════════════════════
// Надсилання push-сповіщень
//
// БЕЗ ЗОВНІШНІХ БІБЛІОТЕК. Уся криптографія — на вбудованому в Node
// модулі crypto. Це свідомий вибір: інакше довелося б правити
// package.json, а зайва кома в JSON ламає всю збірку сайту.
// Формат шифрування перевірено проти еталонної бібліотеки web-push.
//
// ⚠️ ЗМІННІ СЕРЕДОВИЩА у Vercel (Settings → Environment Variables):
//   VAPID_PUBLIC_KEY   — публічний ключ (він же вшитий у застосунок)
//   VAPID_PRIVATE_KEY  — приватний ключ, НІКОЛИ не потрапляє в код
//   VAPID_SUBJECT      — mailto: з вашою поштою (вимога стандарту)
//   PUSH_SECRET        — спільне слово, щоб надсилати могли лише свої
//   SUPABASE_URL       — адреса проєкту Supabase
//   SUPABASE_ANON_KEY  — публічний ключ Supabase
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");

// Скорочений HKDF: нам завжди потрібен рівно один блок.
function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  return crypto.createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, len);
}

// Шифрування вмісту сповіщення ключами конкретного пристрою (RFC 8291).
// Сервер Google чи Apple передає його, не маючи змоги прочитати.
function encryptPayload(uaPublicB64, authB64, payload) {
  const uaPublic = fromB64u(uaPublicB64);
  const auth = fromB64u(authB64);

  const ec = crypto.createECDH("prime256v1");
  ec.generateKeys();
  const asPublic = ec.getPublicKey();
  const shared = ec.computeSecret(uaPublic);

  const ikm = hkdf(auth, shared, Buffer.concat([
    Buffer.from("WebPush: info\0"), uaPublic, asPublic,
  ]), 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // 0x02 — позначка «це останній запис», вимога формату.
  const plain = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Підпис VAPID: доводить push-серверу, що надсилає саме наш застосунок.
function vapidHeader(audience) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const sub = process.env.VAPID_SUBJECT || "mailto:autdoor.actyvni@gmail.com";
  const p = fromB64u(pub);
  const key = crypto.createPrivateKey({
    key: {
      kty: "EC", crv: "P-256",
      d: fromB64u(priv).toString("base64url"),
      x: p.subarray(1, 33).toString("base64url"),
      y: p.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 43200, // 12 годин
    sub,
  }));
  const data = `${head}.${body}`;
  // ieee-p1363 — «сирий» формат підпису з 64 байтів. Стандартний для
  // Node формат DER push-сервери не приймають.
  const sig = crypto.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return { Authorization: `vapid t=${data}.${b64u(sig)}, k=${pub}` };
}

async function sendOne(sub, payload) {
  const url = new URL(sub.endpoint);
  const body = encryptPayload(sub.p256dh, sub.auth, payload);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      ...vapidHeader(url.origin),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
  // 404 і 410 означають, що підписка мертва: людина зняла дозвіл або
  // видалила застосунок. Такі прибираємо, інакше вони накопичуються
  // й уповільнюють кожну наступну розсилку.
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}

async function sb(fn, body) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  try {
    const { secret, title, body, url, tag } = req.body || {};
    if (!process.env.VAPID_PRIVATE_KEY) {
      res.status(500).json({ error: "VAPID_PRIVATE_KEY not set in Vercel" });
      return;
    }
    if (!secret || secret !== process.env.PUSH_SECRET) {
      res.status(403).json({ error: "bad secret" });
      return;
    }
    if (!title) { res.status(400).json({ error: "no title" }); return; }

    const subs = await sb("push_list", { p_secret: secret });
    if (!subs || subs.length === 0) {
      res.status(200).json({ sent: 0, failed: 0, note: "no subscribers" });
      return;
    }

    const payload = JSON.stringify({ title, body: body || "", url: url || "/", tag: tag || "autdoor" });
    let sent = 0, failed = 0;
    const dead = [];

    // Розсилаємо пачками по 20: одночасно всім — і функція впирається
    // в ліміт часу, по одному — надто повільно.
    for (let i = 0; i < subs.length; i += 20) {
      const chunk = subs.slice(i, i + 20);
      const out = await Promise.all(chunk.map((s) =>
        sendOne(s, payload).catch(() => ({ ok: false, gone: false }))
      ));
      out.forEach((r, k) => {
        if (r.ok) sent++; else failed++;
        if (r.gone) dead.push(chunk[k].endpoint);
      });
    }

    for (const e of dead) {
      await sb("push_unsubscribe", { p_endpoint: e }).catch(() => {});
    }

    res.status(200).json({ sent, failed, removed: dead.length });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
