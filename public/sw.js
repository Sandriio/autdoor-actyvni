// ═══ Tropa Club · public/sw.js · ВЕРСІЯ v6 ═══
// v6 — значок сповіщення й маленький значок у рядку стану вшиті прямо в
//      цей файл (картинка як текст, data:). Раніше телефон щоразу
//      завантажував їх з інтернету в мить, коли приходило сповіщення; якщо
//      телефон щойно прокинувся й мережа ще не піднялась — картинки не
//      було, і Android малював свій стандартний дзвіночок. Тепер нічого
//      не завантажується, тож дзвіночка не буде. Якщо котрийсь телефон
//      колись не прийме вшитої картинки — запасний шлях: файли з сайту.
// v5 — натискання на сповіщення веде у потрібне місце: у поїздку, до її
//      запису, місця збору чи контактів, а організатора — до вводу PIN і
//      списку заявок. Куди саме — вирішує сервер, коли надсилає сповіщення.
// v4 — монохромний значок у рядку стану.
// ═══════════════════════════════════════════════════════════════════
// Фоновий скрипт «Tropa Club»
//
// Це окремий файл, який браузер тримає живим, навіть коли застосунок
// закритий. Без нього push-сповіщення неможливі: саме сюди приходить
// повідомлення від сервера й перетворюється на сповіщення на екрані.
//
// ⚠️ Файл мусить лежати в папці `public` і відкриватися за адресою
// <адреса застосунку>/sw.js — на рівні кореня, не глибше. Адреса сайту
// тут ніде не вписана, тож файл однаково працює і на старій, і на новій.
// ═══════════════════════════════════════════════════════════════════

// Позначка версії. Будь-яка зміна цього файлу змушує браузер узяти
// новий скрипт. Застосунок перевіряє оновлення при кожному відкритті й
// показує цю позначку в панелі «Сповіщення» організатора — так видно,
// чи дійшла нова версія саме до цього телефона.
const SW_VERSION = "v6-icons";

// Куди вести після натискання — запасна записка для застосунку. Див.
// пояснення в notificationclick нижче. Назви збігаються з App.jsx.
const GO_CACHE = "tropa-go";
const GO_KEY = "/__tropa-go";

// Значки сповіщення (v6) — вшиті як data:-адреси, щоб їх не треба було
// завантажувати в мить сповіщення. ICON — логотип 192×192, BADGE —
// білий силует туриста 96×96 (той самий, що public/badge-96.png).
const ICON_DATA = "data:image/png;base64,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";
const BADGE_DATA = "data:image/png;base64,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";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Застосунок питає «яка ти версія?» — відповідаємо в наданий канал.
self.addEventListener("message", (event) => {
  if (event.data === "sw-version" && event.ports && event.ports[0]) {
    event.ports[0].postMessage(SW_VERSION);
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "Tropa Club", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Tropa Club";
  const options = {
    body: data.body || "",
    // Логотип праворуч у сповіщенні — вшитий (v6), без завантаження.
    icon: ICON_DATA,
    // badge — маленький значок у рядку стану. Android малює його ЯК
    // МАСКУ: колір ігнорується, враховується лише прозорість. Тому тут
    // силует туриста, а не кольоровий логотип. Немає значка (не
    // завантажився) — система підставляє свій дзвіночок; тому з v6 він
    // вшитий і завантажувати нічого не треба.
    badge: BADGE_DATA,
    vibrate: [120, 60, 120],
    tag: data.tag || "tropa",
    renotify: true,
    // url — куди вести після натискання, наприклад «/?trip=t123&to=booking».
    data: { url: data.url || "/" },
  };

  // Телефон не прийняв вшитої картинки — показуємо з файлами з сайту, як
  // до v6. Сповіщення не має загубитись через значок.
  event.waitUntil(
    self.registration.showNotification(title, options)
      .catch(() => self.registration.showNotification(title, { ...options, icon: "/icon-v3-192.png", badge: "/badge-96.png" }))
  );
});

// ── Натискання на сповіщення ─────────────────────────────────────────
// Три шляхи, бо телефони поводяться по-різному:
//
//  1. Застосунок уже відкритий (хай навіть у фоні) — не перезавантажуємо
//     його, а кажемо, куди перейти. Інакше організатор щоразу втрачав
//     би вхід і вводив PIN наново.
//  2. Застосунок закритий — відкриваємо його одразу за потрібним
//     посиланням.
//  3. Про запас лишаємо записку в сховищі браузера. Буває, що iPhone
//     відкриває застосунок з головної сторінки й посилання ігнорує, —
//     тоді застосунок сам знаходить записку при запуску. Записка
//     одноразова: хоч би яким шляхом перехід відбувся, застосунок
//     її прибирає, а номер переходу (gid) не дає виконати його двічі.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";

  // Лише адреси цього ж сайту: чуже посилання в сповіщенні не
  // відкриється, навіть якщо хтось його туди підсуне.
  let target;
  try { target = new URL(raw, self.location.origin); } catch (e) { target = null; }
  if (!target || target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  const go = target.pathname + target.search;
  const hasGo = target.searchParams.has("trip") || target.searchParams.has("to");
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // Записку починаємо писати відразу, але вікно не чекає на неї: вивести
  // застосунок наперед чи відкрити його телефон дозволяє лише в перші
  // секунди після натискання (iPhone — близько двох).
  // Будь-яка відмова сховища (приватний режим, старий браузер) не мусить
  // зупинити сам перехід — тоді просто без записки.
  const saveNote = () => {
    try {
      return caches.open(GO_CACHE)
        .then((box) => box.put(GO_KEY, new Response(JSON.stringify({ go, id, at: Date.now() }), {
          headers: { "Content-Type": "application/json" },
        })))
        .catch(() => { /* сховище недоступне — лишаються шляхи 1 і 2 */ });
    } catch (e) {
      return Promise.resolve();
    }
  };
  const saved = hasGo ? saveNote() : Promise.resolve();

  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = list.find((c) => c.focused)
      || list.find((c) => c.visibilityState === "visible")
      || list[0];

    if (app) {
      let focusing = Promise.resolve();
      try { focusing = Promise.resolve(app.focus()).catch(() => {}); } catch (e) { /* iPhone сам виводить застосунок наперед */ }
      // Повідомлення — лише коли записка вже лежить. Застосунок, виконавши
      // перехід, записку прибирає; якби вона з'явилась пізніше, наступний
      // запуск повторив би вже виконаний перехід.
      await saved;
      if (hasGo) {
        try { app.postMessage({ type: "tropa-go", go, id }); } catch (e) { /* лишається записка */ }
      }
      await focusing;
      return;
    }

    if (self.clients.openWindow) {
      const url = new URL(go, self.location.origin);
      if (hasGo) url.searchParams.set("gid", id);
      await Promise.all([self.clients.openWindow(url.href).catch(() => {}), saved]);
    } else {
      await saved;
    }
  })());
});
