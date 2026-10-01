// ═══ Tropa Club · public/sw.js · ВЕРСІЯ v5 ═══
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
const SW_VERSION = "v5-go";

// Куди вести після натискання — запасна записка для застосунку. Див.
// пояснення в notificationclick нижче. Назви збігаються з App.jsx.
const GO_CACHE = "tropa-go";
const GO_KEY = "/__tropa-go";

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
    // Шлях мусить збігатися з реальним іменем файлу в папці public.
    // Раніше тут стояло старе ім'я icon-192.png, якого вже немає після
    // перейменування іконок — телефон не знаходив картинку й малював
    // порожній білий квадрат.
    icon: data.icon || "/icon-v3-192.png",
    // badge — це маленький значок у рядку стану. Android малює його ЯК
    // МАСКУ: колір ігнорується, враховується лише прозорість. Тому тут
    // потрібен саме силует, а не кольоровий логотип — інакше виходить
    // біла пляма. Якщо поле не задати взагалі, система підставляє свій
    // дзвіночок.
    badge: data.badge || "/badge-96.png",
    vibrate: [120, 60, 120],
    tag: data.tag || "tropa",
    renotify: true,
    // url — куди вести після натискання, наприклад «/?trip=t123&to=booking».
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
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
