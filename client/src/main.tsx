import { createRoot } from "react-dom/client";
import { CrashBoundary } from "./CrashBoundary.js";
import { installCrashReporting } from "./telemetry.js";
import "./index.css";

installCrashReporting();
const root = createRoot(document.getElementById("root")!);
const dashboardPath = location.pathname === "/metrics-dashboard" ||
  location.pathname === "/metrics-dashboard/";
document.documentElement.classList.toggle("game-shell", !dashboardPath);
document.body.classList.toggle("game-shell", !dashboardPath);

if (dashboardPath) {
  void import("./metrics/MetricsDashboard.js").then(({ MetricsDashboard }) => {
    root.render(<CrashBoundary><MetricsDashboard /></CrashBoundary>);
  });
} else {
  void import("./App.js").then(({ default: App }) => {
    root.render(<CrashBoundary><App /></CrashBoundary>);
  });
}
