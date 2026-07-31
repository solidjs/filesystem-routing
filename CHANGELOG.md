# filesystem-routing

## 0.1.2

### Patch Changes

- c65d71a: keep TypeScript namespace members in route files during production builds
- c65d71a: keep route module ids ending in a real extension so ecosystem plugins match, and name route chunks after their file rather than their pick id

## 0.1.1

### Patch Changes

- b2d32f3: Resolve a relative `dir` against the current working directory. Previously a relative dir silently produced zero routes when using the core router directly, because globbed files came back absolute and failed the relative-pattern route check.
