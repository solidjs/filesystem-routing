---
"filesystem-routing": minor
---

Ship the manifest's consumers alongside the manifest. `filesystem-routing/solid-router` emits `@solidjs/router` route definitions from the nested `pageRoutes` view — code-split `lazy` components deduplicated by source, `route` config exports merged, and a route-scoped CSS lifecycle (ref-counted acquire on mount, release on route leave) over a parameterized client asset manifest. `filesystem-routing/api` serves the flat manifest's `$GET`/`$POST`/… handler refs as fetch-style `(request, next)` middleware: radix-tree matching with `(group)` stripping and catch-alls, params written onto the request event, HEAD→GET fallback, unmatched requests advancing the chain. Both are ports of SolidStart's private implementations, taking manifests as arguments — no virtual-module imports, no framework required.
