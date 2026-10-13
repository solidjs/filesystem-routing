---
"filesystem-routing": minor
---

New `writeRouteTypes` export on `filesystem-routing/vite`: writes the route declaration from a Node script, without starting Vite, so a typecheck can use an up-to-date file. It accepts the plugin's scanning and serialization options, or an existing router. The plugin uses the same writer, which leaves matching contents untouched and resolves to whether it wrote the file.
