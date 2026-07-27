# filesystem-routing

## 0.1.1

### Patch Changes

- b2d32f3: Resolve a relative `dir` against the current working directory. Previously a relative dir silently produced zero routes when using the core router directly, because globbed files came back absolute and failed the relative-pattern route check.
