---
"filesystem-routing": patch
---

Replace `fast-glob` and `micromatch` with `tinyglobby` and `picomatch`, which Vite already installs, so 20 packages, including `@types/micromatch`, are no longer installed. Route scanning now also finds route files when the route directory's path contains an apostrophe and more than one extension is configured; `fast-glob` returned no files in that case.
