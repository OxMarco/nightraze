/* Entry point for embed.html — the document CrazyGames iframes.

   Identical to main.tsx but for the platform install and the wait in front of
   the render. The wait is load-bearing rather than tidy: readName() and
   readBest() are synchronous useState initializers that run during the first
   render, and the SDK's data module only answers once init() has resolved.
   Render first and a returning player gets an empty name field and no personal
   best, then never gets them back, because those values are only ever read
   once.

   Nothing here may throw. platform.ready() resolves even when the SDK is
   missing, disabled or in fail mode, and every event method is a no-op in those
   states, so the arena opens either way. */

import { createRoot } from "react-dom/client";
import App from "./App.js";
import { CrashBoundary } from "./CrashBoundary.js";
import { crazyGamesPlatform } from "./platform/crazygames.js";
import { platform, setPlatform } from "./platform/current.js";
import { installCrashReporting } from "./telemetry.js";
import "./index.css";

setPlatform(crazyGamesPlatform);
document.body.classList.add("game-shell");

// ready() before loadingStart(): the SDK's own handshake is not our loading
// time, and its methods do not answer until it has finished one.
void platform()
  .ready()
  .then(() => {
    installCrashReporting();
    platform().loadingStart();
    createRoot(document.getElementById("root")!).render(<CrashBoundary><App /></CrashBoundary>);
    // The start screen is up on the next paint; that is the moment the player
    // can act, which is what the host is timing.
    requestAnimationFrame(() => platform().loadingStop());
  });
