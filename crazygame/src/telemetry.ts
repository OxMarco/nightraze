import { platform } from "./platform/current.js";

const VISITOR_KEY = "nightraze.visitor.v1";
let installed = false;

export function visitorId(): string {
  const existing = platform().storage.get(VISITOR_KEY);
  if (existing && /^[a-zA-Z0-9_-]{16,64}$/.test(existing)) return existing;
  const created = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");
  platform().storage.set(VISITOR_KEY, created);
  return created;
}

export function clientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

function reportCrash(kind: string): void {
  const body = JSON.stringify({ visitorId: visitorId(), kind: kind.slice(0, 40) });
  void fetch("/telemetry/crash", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => {});
}

/** Install once at entry-point level so render and asynchronous errors count. */
export function installCrashReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", () => reportCrash("window-error"));
  window.addEventListener("unhandledrejection", () => reportCrash("unhandled-rejection"));
}

export function reportRenderCrash(): void {
  reportCrash("react-render");
}
