---
"filesystem-routing": minor
---

Ship the manifest's request-dispatch consumer alongside the manifest. `filesystem-routing/api` serves the flat manifest's `$GET`/`$POST`/… handler refs as fetch-style `(request, next)` middleware: radix-tree matching with `(group)` stripping and catch-alls, params written onto the request event, HEAD→GET fallback, unmatched requests advancing the chain. A port of SolidStart's private implementation, taking the manifest as an argument — no virtual-module imports, no framework required. Route emission stays with each router's own package: Solid Router's adapter is `@solidjs/router/fs`.
