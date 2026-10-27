---
"filesystem-routing": patch
---

Map group-prefixed index files such as `(0)index.mdx` to their directory path again. Since only whole `index` segments were stripped, SolidBase's ordering prefixes turned these pages into `/index` routes.
