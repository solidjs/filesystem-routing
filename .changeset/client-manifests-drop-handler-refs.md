---
'filesystem-routing': patch
---

Client-consumer environments no longer receive handler refs from a shared router: with `httpMethods` on, the serialized `virtual:file-routes` manifest for a non-server environment drops `$GET`/`$POST`/... refs — and handler-only API entries with them — so handler modules and the server-only code they import stay out of the client build. The same filter applies to `buildInputs` entry collection. One router now serves both sides of an SSR app without per-environment duplication; an environment given its own router via `routers` is explicit and serves that router's manifest untouched.
