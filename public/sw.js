// ═══════════════════════════════════════════════════════════════════
// Фоновий скрипт «Аутдор Активні»
//
// Це окремий файл, який браузер тримає живим, навіть коли застосунок
// закритий. Без нього push-сповіщення неможливі технічно: саме сюди
// приходить повідомлення від сервера й перетворюється на сповіщення
// на екрані телефона.
//
// ⚠️ Файл мусить лежати в папці `public` і бути доступним за адресою
// autdoor-actyvni.vercel.app/sw.js — на рівні кореня, не глибше.
// Інакше він зможе обслуговувати лише свою підпапку.
// ═══════════════════════════════════════════════════════════════════

// Нова версія скрипта береться в роботу одразу, без очікування, поки
// користувач закриє всі вкладки. Інакше правки доїжджали б до людей
// через дні.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  // Сервер надсилає JSON. Якщо раптом прийшов простий текст або нічого —
  // показуємо загальне повідомлення, а не мовчимо: краще незрозуміле
  // сповіщення, ніж жодного.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "Аутдор Активні", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Аутдор Активні";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Вібрація коротким подвійним сигналом — щоб відчувалось у кишені.
    vibrate: [120, 60, 120],
    // tag групує сповіщення: нове про ту саму поїздку замінює старе,
    // а не накопичується стосом.
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
