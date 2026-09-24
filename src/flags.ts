/**
 * Facts about the route scan, for emission adapters to gate static imports
 * on. This file is the fallback: every fact is `true`, so code that reads it
 * without the Vite plugin in the loop (dev prebundling, a hand-built
 * manifest, another bundler) errs toward "present", never toward "broken".
 * `filesystem-routing/vite` replaces this module in builds with the scan's
 * actual answers, folded to literals, so an adapter's
 * `if (serverRoutes) use(server)` drops its import when no route needs it.
 */

/** `true` when some page's component is a server function (`server: true`). */
export const serverRoutes: boolean = true;
