// Botbench's service worker (unit 23). It does two things: show a notification Botbench sent, and open Botbench at
// the screen the notification names when it is tapped. It caches nothing and answers no request.

/** The screens a notification may open. Anything else opens the start screen. */
const SCREEN = /^\/#\/(tasks\/[1-9]\d{0,14}|runs\/[1-9]\d{0,14}|settings)$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // Not Botbench's message: shown with the fixed fallback below, as every push must show something.
  }
  const title = typeof message.title === "string" && message.title.length <= 80 ? message.title : "Botbench";
  const path = typeof message.path === "string" && SCREEN.test(message.path) ? message.path : "/";
  event.waitUntil(self.registration.showNotification(title, { icon: "/icons/icon-192.png", data: { path } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = typeof event.notification.data?.path === "string" && SCREEN.test(event.notification.data.path) ? event.notification.data.path : "/";
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        // The page moves to the screen itself (src/app/notifications.ts): only the part after # changes, so nothing reloads.
        open.postMessage({ type: "botbench-open", path });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
