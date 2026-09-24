/**
 * The virtual module that serves the serialized route manifest.
 *
 * `virtual:` is Vite's convention for plugin-served modules, and the name is
 * not tied to any router. Override it with the plugin's `moduleId` option.
 */
export const moduleId = "virtual:file-routes";

export const DEFAULT_EXTENSIONS = ["js", "jsx", "ts", "tsx", "tsrx"];

/**
 * The module adapters import scan facts from — `filesystem-routing/flags`.
 * The package ships it as a real file whose facts are all `true` (the safe
 * answer wherever no plugin hook is in the loop: dev prebundling, a custom
 * manifest, another bundler); the Vite plugin serves the scan's answer in
 * builds so gated code folds away.
 */
export const flagsId = "filesystem-routing/flags";
export const resolvedFlagsId = "\0" + flagsId;
