---
"filesystem-routing": patch
---

Keep the manifest in scan order when the watcher changes a route. An edited route file was moved to the end of the manifest, and a re-created or new file was appended, so the generated types and the manifest order changed during development. Edited routes now stay in place, and added routes are inserted where a full scan would put them.
