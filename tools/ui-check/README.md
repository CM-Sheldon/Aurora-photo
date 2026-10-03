# UI checks (headless iPhone + desktop)

Browser-level checks for the Aurora web UI, run against a **throwaway copy** of
the app — never the live service. Nothing here is deployed; the update zip only
ships `app/`.

```bash
cd tools/ui-check
npm install && npx playwright install chromium-headless-shell   # once
./dev-server.sh               # snapshot the DB, start this checkout on :8091
export AURORA_TOKEN=…         # printed by dev-server.sh
node smoke.mjs                # every screen on an iPhone 15 Pro + desktop → ./out/*.png
node gestures.mjs             # real touch gestures: swipe, pinch, long-press, sweep-select…
node perf.mjs                 # long-task blocking + DOM size while flinging
```

- `smoke.mjs` screenshots each screen and fails on any page/console error.
- `gestures.mjs` drives CDP touch events (so touch *and* pointer handlers fire as
  on a phone) and prints PASS/FAIL per gesture. It creates and deletes one test
  album in the snapshot DB.
- `perf.mjs` reports long tasks while scrolling. The Library fling should stay at
  **0 ms blocking** with ~100 tiles in the DOM; treat any regression as a bug.
- Screenshots contain real photos — `out/` is git-ignored. Keep it that way.
- Headless Chromium has no safe-area insets, keyboard or real GPU, so always do a
  final pass on the actual iPhone home-screen app (`?debug=1` shows the perf HUD).
