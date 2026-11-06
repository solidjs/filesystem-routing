---
"filesystem-routing": patch
---

Remove the Babel dependency. The `?pick=` pass now parses with `oxc-parser` and edits with `magic-string`, so the source text of kept code is preserved rather than reprinted. `@babel/core`, `@types/babel__core` and `@types/babel__traverse` are no longer installed. Four cases where the Babel pass produced wrong code now behave correctly: removing an element of an array pattern no longer shifts the elements after it (`const [read, write]` could become `const [write]`), siblings of a live object rest element stay so `rest` keeps its contents, named function expressions keep the bindings they use, and a function whose body declares its own name is no longer treated as unreferenced or removed while in use. The result also no longer depends on whether an unpicked `export { name }` is written before or after the declaration of `name`. Decorators now parse.
