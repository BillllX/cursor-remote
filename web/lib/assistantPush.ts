function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerAssistantPush(pushKey: string, basePath: string) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("这个浏览器不支持 Web 推送。");
  }
  const base = basePath || "";
  const reg = await navigator.serviceWorker.register(`${base}/sw.js`, { scope: `${base}/` });
  await reg.update();
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("没有通知权限。");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushKey),
    });
  }
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("订阅信息不完整。");
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    ua: navigator.userAgent.slice(0, 120),
  };
}

export async function closeInboxNotification(itemId: string) {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const note = await reg?.getNotifications({ tag: itemId });
  note?.forEach((n) => n.close());
}
