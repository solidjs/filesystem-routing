# filesystem-routing

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
