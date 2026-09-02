---
"filesystem-routing": minor
---

Support `.tsrx` route modules. Export analysis routes by filename: `.tsrx` files parse through `@tsrx/oxc/parser` (a new optional peer dependency, loaded lazily only when a `.tsrx` route is scanned — its `ParseResult` mirrors `oxc-parser`, so analysis semantics are unchanged), everything else keeps the exact `oxc-parser` path. The Vite adapter's `DEFAULT_EXTENSIONS` now includes `tsrx`, so `.tsrx` pages participate in routing without an `extensions` override. Scanning a `.tsrx` route without `@tsrx/oxc` installed fails with an error naming the module and the fix.
