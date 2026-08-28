// ═══════════════════════════════════════════════════════════════════
// Фоновий скрипт «Аутдор Активні»
//
// Це окремий файл, який браузер тримає живим, навіть коли застосунок
// закритий. Без нього push-сповіщення неможливі: саме сюди приходить
// повідомлення від сервера й перетворюється на сповіщення на екрані.
//
// ⚠️ Файл мусить лежати в папці `public` і відкриватися за адресою
// autdoor-actyvni.vercel.app/sw.js — на рівні кореня, не глибше.
// ═══════════════════════════════════════════════════════════════════

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "Аутдор Активні", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Аутдор Активні";
  const options = {
    body: data.body || "",
    // Шлях мусить збігатися з реальним іменем файлу в папці public.
    // Раніше тут стояло старе ім'я icon-192.png, якого вже немає після
    // перейменування іконок — телефон не знаходив картинку й малював
    // порожній білий квадрат.
    icon: "/icon-v3-192.png",
    // badge — це маленький значок у рядку стану. Android малює його ЯК
    // МАСКУ: колір ігнорується, враховується лише прозорість. Тому тут
    // потрібен саме силует, а не кольоровий логотип — інакше виходить
    // біла пляма. Якщо поле не задати взагалі, система підставляє свій
    // дзвіночок.
    badge: "/badge-96.png",
    vibrate: [120, 60, 120],
    tag: data.tag || "autdoor",
    renotify: true,
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  // Якщо застосунок уже відкритий — переводимо фокус на нього замість
  // того, щоб плодити другу вкладку.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client && target !== "/") client.navigate(target);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
