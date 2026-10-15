// Minimal stand-in for apps/web/src/lib/travel/execution.ts.
// Node 26 strip-only TS loading cannot transform its parameter properties,
// and the traced run has no cancellation context: currentTravelExecution()
// returning undefined makes launchBrowser() take the plain-launch path,
// identical launch flags, no lifecycle wrapping.
export class TravelCleanupError extends AggregateError {
  constructor(errors, message, options) {
    super(errors, message, options);
    this.name = 'TravelCleanupError';
  }
}
export class TravelExecution {}
export function currentTravelExecution() { return undefined; }
export async function closeTravelBrowser(browser) { await browser.close(); }
export async function withTravelExecution(_execution, work) { return work(); }
export async function travelDelay(milliseconds) { await new Promise(resolve => setTimeout(resolve, milliseconds)); }
