import { getPushKey, pushSubscribed, removePushSubscription, savePushSubscription, sendTestNotification, type DeviceSubscription } from "../api/client.ts";

/*
 * Notifications on this device (unit 23). The service worker (public/sw.js) shows what Botbench sends and opens the
 * screen a notification names; this module registers it, moves the page when a notification is tapped while Botbench
 * is open, and turns notifications on and off for this device. The state it reports is what the browser and Botbench
 * hold now, never a guess.
 */

/** The screens a notification may open, as the service worker sends them. */
const SCREEN = /^\/#\/(tasks\/[1-9]\d{0,14}|runs\/[1-9]\d{0,14}|settings)$/;

/** Register the service worker and follow the notifications it opens. Does nothing where the browser has none. */
export function startServiceWorker(): void {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err: unknown) => console.error("Botbench's service worker did not register:", err));
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; path?: unknown } | null;
    if (data?.type === "botbench-open" && typeof data.path === "string" && SCREEN.test(data.path)) window.location.hash = data.path.slice(2);
  });
}

export type NotificationState = "on" | "off" | "blocked" | "install-first" | "needs-https" | "unsupported";

/** The state line for each state, in the voice's words. */
export const STATE_WORDS: Record<NotificationState, string> = {
  on: "On for this device",
  off: "Off",
  blocked: "Not allowed in the browser's settings",
  "install-first": "Not available: add Botbench to the Home Screen first",
  "needs-https": "Not available: open Botbench at its HTTPS address",
  unsupported: "Not available in this browser",
};

const isIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = (): boolean => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** What keeps this device from notifications altogether, or null when it can have them. */
function unavailable(): NotificationState | null {
  if (!window.isSecureContext) return "needs-https";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    // iOS offers notifications only to a web app added to the Home Screen.
    return isIos() && !installed() ? "install-first" : "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  return null;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration("/")) ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

const keyBytes = (key: string): Uint8Array<ArrayBuffer> => {
  const text = atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "="));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null, b: Uint8Array): boolean => a !== null && a.byteLength === b.length && new Uint8Array(a).every((v, i) => v === b[i]);

/**
 * This device's state now. "On" only when the browser holds a subscription made with Botbench's current key and
 * Botbench has it stored; a subscription Botbench no longer has (expired, or made with old keys) is dropped here.
 */
export async function notificationState(): Promise<NotificationState> {
  const blocked = unavailable();
  if (blocked !== null) return blocked;
  const subscription = await (await registration()).pushManager.getSubscription();
  if (subscription === null) return "off";
  const current = sameKey(subscription.options.applicationServerKey, keyBytes(await getPushKey())) && (await pushSubscribed(subscription.endpoint));
  if (current) return "on";
  await subscription.unsubscribe();
  return "off";
}

/** Ask the browser, subscribe with Botbench's key and store the subscription. Returns the state that results. */
export async function turnOn(key: string): Promise<NotificationState> {
  // Asked first, straight from the tap: iOS asks only in answer to one.
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";
  const reg = await registration();
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await savePushSubscription(subscription.toJSON() as DeviceSubscription);
  return "on";
}

/** Delete the subscription from Botbench, then from the browser. */
export async function turnOff(): Promise<NotificationState> {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (subscription !== null) {
    await removePushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return "off";
}

export async function sendTest(): Promise<void> {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (subscription === null) throw new Error("Notifications are not on for this device. Choose Allow notifications first.");
  await sendTestNotification(subscription.endpoint);
}
