import { createRoot } from "react-dom/client";
import { CrashBoundary } from "./CrashBoundary.js";
import { installCrashReporting } from "./telemetry.js";
import { installViewportVars } from "./viewport.js";
import "./index.css";

installCrashReporting();
const root = createRoot(document.getElementById("root")!);
const dashboardPath = location.pathname === "/metrics-dashboard" ||
  location.pathname === "/metrics-dashboard/";
document.documentElement.classList.toggle("game-shell", !dashboardPath);
document.body.classList.toggle("game-shell", !dashboardPath);
// The dashboard is a normal scrolling document, where pageTop tracks the scroll
// and the offset would be actively wrong; only the fixed arena shell needs it.
if (!dashboardPath) installViewportVars();

if (dashboardPath) {
  void import("./metrics/MetricsDashboard.js").then(({ MetricsDashboard }) => {
    root.render(<CrashBoundary><MetricsDashboard /></CrashBoundary>);
  });
} else {
  void import("./App.js").then(({ default: App }) => {
    root.render(<CrashBoundary><App /></CrashBoundary>);
  });
}
