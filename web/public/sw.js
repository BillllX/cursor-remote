/* 个人助理 Web 推送：只处理 push / notificationclick，不缓存页面 */
self.addEventListener("push", (event) => {
  let payload = { title: "助理", body: "", url: "", itemId: "", kind: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    /* 忽略坏包 */
  }
  const tag = payload.itemId || payload.kind || "assistant";
  event.waitUntil(
    self.registration.showNotification(payload.title || "助理", {
      body: payload.body || "",
      tag,
      data: { url: payload.url, itemId: payload.itemId },
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data?.url;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          if (raw) client.navigate(raw);
          return;
        }
      }
      if (raw) return self.clients.openWindow(raw);
      return undefined;
    }),
  );
});
