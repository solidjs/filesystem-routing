# filesystem-routing

## 0.3.0

### Minor Changes

- be5f6d7: Support `.tsrx` route modules. Export analysis routes by filename: `.tsrx` files parse through `@tsrx/oxc/parser` (a new optional peer dependency, loaded lazily only when a `.tsrx` route is scanned — its `ParseResult` mirrors `oxc-parser`, so analysis semantics are unchanged), everything else keeps the exact `oxc-parser` path. The Vite adapter's `DEFAULT_EXTENSIONS` now includes `tsrx`, so `.tsrx` pages participate in routing without an `extensions` override. Scanning a `.tsrx` route without `@tsrx/oxc` installed fails with an error naming the module and the fix.

## 0.2.1

### Patch Changes

- 0dce18d: Client-consumer environments no longer receive handler refs from a shared router: with `httpMethods` on, the serialized `virtual:file-routes` manifest for a non-server environment drops `$GET`/`$POST`/... refs — and handler-only API entries with them — so handler modules and the server-only code they import stay out of the client build. The same filter applies to `buildInputs` entry collection. One router now serves both sides of an SSR app without per-environment duplication; an environment given its own router via `routers` is explicit and serves that router's manifest untouched.
- eab4080: New `codeSplitting` option on the Vite delivery adapter: `fileRoutes({ codeSplitting: false })` delivers every `$`-prefixed module ref eagerly — a static namespace import behind the `require()` shape eager refs already carry, plus the `src` lazy refs expose — so the built output contains zero dynamic imports and no per-route chunks. Splitting stays the default and is unchanged, but it is not always a win: on a small app the per-chunk overhead can leave the split bundle larger, and some deploy targets prefer a single bundle. Consumers need no switch of their own, because refs are self-describing (`import()` vs `require()`): `filesystem-routing/api` dispatches either shape, emission adapters branch on what they are handed (`@solidjs/router/fs` passes eagerly delivered components through without `lazy()`), and generated type declarations describe refs as delivered. With splitting off, `buildInputs` contributes no entries — route modules are statically reachable from the manifest. Note: with `@solidjs/router`, `codeSplitting: false` requires the next release (newer than `2.0.0-next.14`); against `next.14` or older, enabling the option fails at first render.

## 0.2.0

### Minor Changes

- 666e4e0: Ship the manifest's request-dispatch consumer alongside the manifest. `filesystem-routing/api` serves the flat manifest's `$GET`/`$POST`/… handler refs as fetch-style `(request, next)` middleware: radix-tree matching with `(group)` stripping and catch-alls, params written onto the request event, HEAD→GET fallback, unmatched requests advancing the chain. A port of SolidStart's private implementation, taking the manifest as an argument — no virtual-module imports, no framework required. Route emission stays with each router's own package: Solid Router's adapter is `@solidjs/router/fs`.

## 0.1.2

### Patch Changes

- c65d71a: keep TypeScript namespace members in route files during production builds
- c65d71a: keep route module ids ending in a real extension so ecosystem plugins match, and name route chunks after their file rather than their pick id

## 0.1.1

### Patch Changes

- b2d32f3: Resolve a relative `dir` against the current working directory. Previously a relative dir silently produced zero routes when using the core router directly, because globbed files came back absolute and failed the relative-pattern route check.
