---
"filesystem-routing": patch
---

Fix three cases where a `?pick=` module could break or ship unpicked code. When nothing is left after picking, the module is now empty instead of being served whole, so unpicked exports and their imports no longer ship. A CSS module import such as `import styles from "./page.module.css"` now stays while picked code reads it, instead of being removed with the stylesheet imports and leaving `styles` undefined. An unpicked export that a dead binding calls while the module evaluates, such as `const a = [GET(), () => b]`, is now kept instead of removed, which used to throw a `ReferenceError`.
