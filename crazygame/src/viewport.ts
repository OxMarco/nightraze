/* iOS Safari lays `position: fixed` out against the *layout* viewport, which is
   not the region the player can see. With the URL bar expanded the layout box
   is both taller than the visible area and starts above it — measured on
   iPhone 17 Pro / iOS 26: layout 714px, visible 669px, layout top 45px above the
   fold. A HUD pinned to `top: 14px` therefore paints at -31px and is simply
   gone, taking the "leaderboard" header and the rank-1 row with it.

   `env(safe-area-inset-top)` cannot rescue this: in ordinary Safari browsing
   (as opposed to a standalone/PWA window) every inset reports 0, because the
   browser chrome already excludes its own bars. Nor is it a document scroll —
   `scrollTo(0, 0)` does not move it, and pinning html/body to
   `visualViewport.height` leaves the offset untouched.

   So the visible region has to be described to CSS directly. These two custom
   properties do that in layout coordinates: `--vv-top` is where the visible
   region begins, `--vv-height` is how tall it is. Top-anchored and full-screen
   fixed UI adds them and thereby tracks what the player is actually looking at.
   Anything anchored to `bottom` is already correct and must be left alone — the
   layout and visual viewports share a bottom edge. On every browser without the
   quirk `--vv-top` stays 0 and the arithmetic is a no-op. */

export function installViewportVars(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const sync = () => {
    const style = document.documentElement.style;
    // pageTop, not offsetTop: offsetTop measures a pinch-zoom pan within the
    // layout viewport and reads 0 in exactly the state that breaks the HUD.
    style.setProperty("--vv-top", `${Math.max(0, Math.round(vv.pageTop))}px`);
    style.setProperty("--vv-height", `${Math.round(vv.height)}px`);
  };

  sync();
  // resize fires as the URL bar expands and collapses, scroll as the visual
  // viewport pans; both change where the visible region sits.
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
}
