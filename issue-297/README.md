# Issue #297 diagnostics — Google Hotels "Stay total" timeouts

Artifacts for [affromero/flight-finder#297](https://github.com/affromero/flight-finder/issues/297).
See the issue comment for the narrative; this directory holds the harness and the
traced runs taken on 2026-10-15.

## Outcome in one line

The reported failures died with the previous container (replaced 2026-10-14
12:23 UTC); since the rebuild, `selectGoogleTotal()` passed every traced capture
in both process modes, so no failing trace exists to attach.

## `harness/` — traced reproduction harness

Runs **inside** the self-hosted container and imports the container's own
scraper sources (verified byte-identical to tag `v0.15.0` for
`hotels/google.ts`, `hotels/navigation.ts`, `hotels/link-capture.ts`,
`scraper/browser.ts`, `scraper/country-profiles.ts`, `travel/navigation.ts`),
replaying `captureHotelSource()` / `searchHotelSource()` 1:1 with Playwright
tracing around each property capture.

```sh
docker cp harness flight-finder-web:/tmp/ff-trace
docker exec -w /app flight-finder-web \
  node --experimental-strip-types --import /tmp/ff-trace/hooks.mjs /tmp/ff-trace/runner.mjs
# optional knobs:
#   PROPERTY_LIMIT=8            property captures per run (default 8)
#   BROWSER_SINGLE_PROCESS=…    override the container env (launch flag mode)
#   TRACE_OUT=/tmp/ff-traces    output directory for trace zips + report.json
#   DUMP_LINKS=1                dump all captured anchors into the report
```

Notes on fidelity:

- The only substitution is `harness/execution-stub.mjs` for
  `travel/execution.ts` (Node 26 strip-only TS loading cannot transform its
  parameter properties, and a standalone run has no cancellation context;
  `currentTravelExecution()` returning `undefined` takes the identical
  plain-launch path in `launchBrowser()` — same flags, no lifecycle wrapping).
- On failure the runner dumps a post-mortem before closing the page: trigger
  aria-labels with `aria-expanded`, `Stay total` node presence / visibility /
  bounding rect, open `menu`/`dialog`/`listbox` overlays, console tail — this
  distinguishes "menu never opened" from "menu open but click blocked".
- Tracing starts before navigation and stops after `selectGoogleTotal()`,
  per the request in the issue.

## `runs/` — traced runs (2026-10-15, all passing)

| File | Mode | Result |
|---|---|---|
| `report-single-process.json` | deployment mode, `BROWSER_SINGLE_PROCESS=true` → `--single-process --in-process-gpu` | 8/8 properties OK |
| `trace-single-process-property-00.zip` | the same run, property 0 | `playwright show-trace` |
| `report-multi-process.json` | `BROWSER_SINGLE_PROCESS=false` | 4/4 properties OK |
| `trace-multi-process-property-00.zip` | the same run, property 0 | `playwright show-trace` |

Search parameters for both runs: destination `Tbilisi`, 2026-11-24 → 2026-11-27
(3 nights), 1 room × 2 adults, `EUR`, GB stealth profile (`en-GB`,
`Europe/London`, London geolocation), `hl=en&gl=gb&curr=EUR`.

Environment: image `flight-finder:0.15.0-booking-guests`
(`sha256:634ddf1930070ca6be8e1c9846e44650d4913be6678ca21ecda594b70359eb1b`),
Playwright 1.62.1, Chromium 152.0.7977.82 (Alpine arm64, `CHROME_PATH=/usr/bin/chromium-browser`),
Node 26.11.1, egress 91.153.156.167 (FI, no proxy for hotel captures).
