---
"filesystem-routing": minor
---

Server-function pages, behind `serverComponents: true`: a route module whose default export begins with a `"use server"` directive is flagged `server: true` and its `$component` ref marked `eager` (picking only `default`), so the Vite adapter delivers the stub as a static import even with code splitting on and it is not a build input. A new `filesystem-routing/flags` module exposes scan facts (`serverRoutes`) for emission adapters to gate static imports on: the shipped file says `true`; the Vite plugin serves the scan's answer in builds, folded to a literal, so gated code tree-shakes out of apps with no server page. `ModuleRef.eager` and `RouteManifestEntry.server` are added to the neutral manifest; `analyzeRouteModule` returns the default export's directive alongside the exports. Off by default: existing manifests are unchanged.
