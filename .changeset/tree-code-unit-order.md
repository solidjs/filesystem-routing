---
"filesystem-routing": patch
---

`buildRouteTree` breaks ties between sibling routes of equal path length by UTF-16 code unit instead of `localeCompare`, so the tree, and the declarations generated from it, come out in the same order on every machine whatever its locale. This matches the order the scan already sorts route files in.
