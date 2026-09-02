import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { PluginOption } from "vite";

import { PageFileSystemRouter, type PageFileSystemRouterConfig } from "../convention.ts";
import type { ModuleRef, RouteManifestEntry } from "../manifest.ts";
import { BaseFileSystemRouter, normalizePath } from "../router.ts";
import { buildRouteTree, type RouteTreeEntry } from "../tree.ts";
import { DEFAULT_EXTENSIONS, moduleId } from "./constants.ts";
import { fileSystemWatcher } from "./fs-watcher.ts";
import { sanitizeChunkFileName, toPickId, treeShake } from "./tree-shake.ts";
import { serializeTypes } from "./types.ts";

export { DEFAULT_EXTENSIONS, moduleId };
export { sanitizeChunkFileName, toPickId, treeShake } from "./tree-shake.ts";
export { fileSystemWatcher } from "./fs-watcher.ts";

export interface FileRoutesOptions extends Pick<
  PageFileSystemRouterConfig,
  "components" | "httpMethods" | "toPath" | "toRoute"
> {
  /** Route directory, relative to the Vite root. Defaults to `src/routes`. */
  dir?: string;
  /** File extensions that participate in routing. Defaults to js/jsx/ts/tsx. */
  extensions?: string[];
  /**
   * A custom file-system router (scanning + convention) used for every Vite
   * environment. Defaults to a `PageFileSystemRouter` over `dir`, configured
   * with the convention options above.
   */
  router?: BaseFileSystemRouter;
  /**
   * Per-environment file-system routers, keyed by Vite environment name.
   * Frameworks (e.g. SolidStart) use this to serve different conventions to
   * client and server environments. Falls back to `router` for environments
   * not listed.
   */
  routers?: Record<string, BaseFileSystemRouter>;
  /** The id the route manifest is served from. Defaults to `virtual:file-routes`. */
  moduleId?: string;
  /**
   * Vite environments whose build should take every route module as an
   * entry, so routes are code-split into their own chunks. Frameworks pass
   * their browser environment's name; the inputs are added to whatever the
   * framework already configures.
   */
  buildInputs?: string | string[];
  /**
   * Deliver `$`-prefixed module refs as code-split dynamic imports, each
   * route its own chunk. The default. Set to `false` to deliver every ref
   * eagerly instead — static imports, `require()`-shaped refs, zero dynamic
   * imports in the output — for the apps where splitting loses: small apps
   * whose per-chunk overhead outweighs the split, and targets that want a
   * single bundle. Adapters need no switch of their own: refs are
   * self-describing (`import()` is code-split, `require()` is eager), and
   * emission adapters branch on the shape they are handed.
   *
   * With `@solidjs/router`, `codeSplitting: false` requires the next release
   * (newer than `2.0.0-next.14`): its adapter must branch on eager refs, and
   * against `next.14` or older, enabling this option fails at first render.
   */
  codeSplitting?: boolean;
  /**
   * Packages that import the virtual module and must therefore stay out of
   * esbuild's dependency prebundling, which cannot resolve it. Emission
   * adapters are expected to take the manifest as an argument instead of
   * importing the virtual module (so app source holds the only import, which
   * prebundling never touches), making this an escape hatch for packages
   * that import it anyway. Defaults to `[]`.
   */
  optimizeDepsExclude?: string[];
  /**
   * Write a declaration for the virtual module typing the manifest as a
   * literal tuple, and keep it in step with the route directory. Routers
   * that derive types from their route table need this: a runtime array
   * tells them nothing, so path-derived types silently degrade without it.
   *
   * `true` writes `file-routes.d.ts` next to the Vite root; pass a path to
   * put it elsewhere. The generated file is self-contained — reference it
   * *instead of* `filesystem-routing/types`, never both.
   */
  types?: boolean | string;
}

/**
 * Handler refs are the `$`-prefixed all-uppercase keys the convention emits
 * (`$GET`, `$POST`, ...). They exist for server dispatch only.
 */
const HANDLER_REF = /^\$[A-Z]+$/;

/**
 * Whether a Vite environment runs on the server. `configEnvironment` sees
 * `consumer` only when something set it explicitly, so fall back to Vite's
 * own default: the `client` environment is the one client consumer.
 */
const isServerConsumer = (name: string, consumer: string | undefined) =>
  (consumer ?? (name === "client" ? "client" : "server")) === "server";

/**
 * The client's view of a shared server manifest: handler refs removed. A
 * client bundle can never invoke a request handler, but serializing its ref
 * would pull the handler module — and the server-only code it imports —
 * into the client build. Handler-only entries (API routes) disappear
 * entirely; pages that also export handlers keep their page refs.
 */
function stripHandlerRefs(routes: RouteManifestEntry[]): RouteManifestEntry[] {
  const stripped: RouteManifestEntry[] = [];
  for (const route of routes) {
    const handlerKeys = Object.keys(route).filter(key => HANDLER_REF.test(key));
    if (!handlerKeys.length) {
      stripped.push(route);
      continue;
    }
    const rest: RouteManifestEntry = { ...route };
    for (const key of handlerKeys) delete rest[key];
    // Entries carry `$component: undefined` placeholders; only a ref with a
    // value keeps a handler-only entry alive. Otherwise not even the API
    // path string reaches the client bundle.
    if (
      rest.page ||
      Object.keys(rest).some(key => key.startsWith("$") && rest[key] !== undefined)
    ) {
      stripped.push(rest);
    }
  }
  return stripped;
}

/**
 * The Vite delivery adapter for `filesystem-routing`.
 *
 * Serializes the neutral route manifest into the virtual module — module refs
 * become code-split dynamic imports (`$`-prefixed keys) or eagerly required
 * static imports (`$$`-prefixed keys) — and keeps it hot as route files are
 * added, changed and removed.
 *
 * The module serves two views of the same entries: the default export is the
 * flat manifest, and `pageRoutes` is the page entries nested by path with
 * `(group)` segments stripped, so emission adapters don't each reimplement
 * the tree.
 *
 * With `httpMethods` on, one router serves both sides of an SSR app: the
 * handler refs it emits reach server-consumer environments only, and client
 * manifests drop them (and handler-only API entries with them) so handler
 * modules never enter a client build. An environment given its own router
 * via `routers` is explicit and serves that router's manifest untouched.
 */
export function fileRoutes(options: FileRoutesOptions = {}): PluginOption[] {
  const virtualId = options.moduleId ?? moduleId;
  const codeSplitting = options.codeSplitting !== false;
  const buildInputs =
    options.buildInputs === undefined
      ? []
      : Array.isArray(options.buildInputs)
        ? options.buildInputs
        : [options.buildInputs];

  let defaultRouter = options.router;
  let root = process.cwd();

  const getRouter = (environment: string) => options.routers?.[environment] ?? defaultRouter;

  /**
   * The manifest the declaration describes. With per-environment routers the
   * browser's is the one an app's routes are built from, so it wins.
   */
  const typesRouter = () => getRouter("client");

  const typesFile = () =>
    options.types === undefined || options.types === false
      ? undefined
      : resolve(root, options.types === true ? "file-routes.d.ts" : options.types);

  async function writeTypes() {
    const file = typesFile();
    const router = typesRouter();
    if (!file || !router) return;

    const routes = (await router.getRoutes()) ?? [];
    const contents = serializeTypes(
      virtualId,
      routes,
      buildRouteTree(routes.filter(route => route.page)),
      dirname(file),
      codeSplitting
    );

    // Only touch the file when it actually changes: every environment calls
    // this, and rewriting it would churn the watcher for no reason.
    let previous;
    try {
      previous = readFileSync(file, "utf-8");
    } catch {}
    if (previous === contents) return;

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  /** The id a route module ref is loaded from: its source plus its picks. */
  const toModuleId = (ref: ModuleRef) => toPickId(ref.src, ref.pick);

  return [
    {
      name: "filesystem-routing",
      enforce: "pre",
      config() {
        return {
          build: {
            rollupOptions: {
              output: {
                // Keeps route chunks named after their file rather than after
                // the `?pick=...` id that addresses them. See toPickId.
                sanitizeFileName: sanitizeChunkFileName
              }
            }
          },
          // Packages importing the virtual module (which only this plugin can
          // resolve) must stay out of esbuild prebundling.
          ...(options.optimizeDepsExclude?.length
            ? { optimizeDeps: { exclude: options.optimizeDepsExclude } }
            : {})
        };
      },
      configResolved(config) {
        root = config.root;
        if (!defaultRouter) {
          defaultRouter = new PageFileSystemRouter({
            dir: normalizePath(resolve(config.root, options.dir ?? "src/routes")),
            extensions: options.extensions ?? DEFAULT_EXTENSIONS,
            components: options.components,
            httpMethods: options.httpMethods,
            toPath: options.toPath,
            toRoute: options.toRoute
          });
        }
      },
      async buildStart() {
        await writeTypes();
      },
      async configEnvironment(name, _config, env) {
        // Without code splitting no ref becomes a dynamic import, so no
        // route module needs to be an entry: they are all statically
        // reachable from the virtual module.
        if (!codeSplitting) return;
        if (env.command !== "build" || !buildInputs.includes(name)) return;

        const router = getRouter(name);
        if (!router) return;

        // A client environment on the shared router never serializes
        // handler refs (see load), so their modules must not become its
        // build entries either.
        const routes =
          options.routers?.[name] || isServerConsumer(name, (_config as any).consumer)
            ? await router.getRoutes()
            : stripHandlerRefs(await router.getRoutes());

        // Every code-split route module is an entry of its own, so the
        // manifest's dynamic imports resolve to real chunks. `$$` refs are
        // inlined into the manifest and need no entry.
        const input: string[] = [];
        for (const route of routes) {
          for (const [key, ref] of Object.entries(route)) {
            if (ref && key.startsWith("$") && !key.startsWith("$$")) {
              input.push(toModuleId(ref as ModuleRef));
            }
          }
        }
        if (!input.length) return;

        return { build: { rollupOptions: { input } } };
      },
      resolveId(source) {
        if (source === virtualId) return virtualId;
      },
      async load(loadedId) {
        if (loadedId !== virtualId) return;

        const root = this.environment.config.root;
        const isBuild = this.environment.mode === "build";
        const js = jsCode();

        const environmentName = this.environment.name;
        const router = getRouter(environmentName);
        let routes = (router ? await router.getRoutes() : []) ?? [];
        // The shared router serves every environment, so the split is this
        // adapter's job: client consumers get the manifest without handler
        // refs. An explicit per-environment router already IS the split —
        // serve whatever it emits.
        if (
          !options.routers?.[environmentName] &&
          !isServerConsumer(environmentName, this.environment.config.consumer)
        ) {
          routes = stripHandlerRefs(routes);
        }

        const serializeEntry = (entry: unknown) =>
          JSON.stringify(entry, (key, value) => {
            if (value === undefined) return undefined;

            if (key.startsWith("$$")) {
              const buildId = toModuleId(value);

              const refs: Record<string, string> = {};
              for (const pick of value.pick) {
                refs[pick] = js.addNamedImport(pick, buildId);
              }
              return {
                require: `_$() => ({ ${Object.entries(refs)
                  .map(([pick, namedImport]) => `'${pick}': ${namedImport}`)
                  .join(", ")} })$_`
              };
            } else if (key.startsWith("$")) {
              const buildId = toModuleId(value);
              // With code splitting off the ref is delivered eagerly: a
              // namespace import (named imports would fail on the synthetic
              // `$css` pick) behind the `require()` shape eager refs carry,
              // plus the `src` lazy refs already expose.
              if (!codeSplitting) {
                return {
                  src: relative(root, buildId),
                  require: `_$() => (${js.addNamespaceImport(buildId)})$_`
                };
              }
              return {
                src: relative(root, buildId),
                build: isBuild ? `_$() => import('${buildId}')$_` : undefined,
                import: `_$() => import('${buildId}')$_`
              };
            }
            return value;
          })
            .replaceAll('"_$(', "(")
            .replaceAll(')$_"', ")");

        // Emit the fields that both views share once. Each view adds its own
        // path, so the nested view does not overwrite the flat manifest path.
        const bindings = routes.map((route, index) => {
          const { path: _path, ...fields } = route;
          return `const route${index} = ${serializeEntry(fields)};`;
        });

        const tree = buildRouteTree(
          routes
            .map((route, index) => ({ path: route.path, page: route.page, index }))
            .filter(stub => stub.page)
        );

        const serializeTree = (nodes: RouteTreeEntry[]): string =>
          `[${nodes
            .map(node => {
              const fields = [
                `...route${node.index as number}`,
                `id: ${JSON.stringify(node.id)}`,
                `path: ${JSON.stringify(node.path)}`
              ];
              if (node.children) fields.push(`children: ${serializeTree(node.children)}`);
              return `{ ${fields.join(", ")} }`;
            })
            .join(", ")}]`;

        return `${js.getImportStatements()}
${bindings.join("\n")}
const routes = [${routes
          .map((route, index) => `{ path: ${JSON.stringify(route.path)}, ...route${index} }`)
          .join(", ")}];
export default routes;
export const pageRoutes = ${serializeTree(tree)};
`;
      }
    },
    treeShake(),
    fileSystemWatcher(getRouter, virtualId, writeTypes)
  ];
}

function jsCode() {
  const imports = new Map<string, Record<string, string>>();
  const namespaceImports = new Map<string, string>();
  let vars = 0;

  function addNamedImport(name: string, source: string) {
    let names = imports.get(source);
    if (!names) {
      names = {};
      imports.set(source, names);
    }

    // The same export can be reached through more than one ref; reuse the
    // binding instead of importing it twice.
    const existing = names[name];
    if (existing) return existing;

    const alias = "routeData" + vars++;
    names[name] = alias;
    return alias;
  }

  function addNamespaceImport(source: string) {
    const existing = namespaceImports.get(source);
    if (existing) return existing;

    const alias = "routeModule" + namespaceImports.size;
    namespaceImports.set(source, alias);
    return alias;
  }

  const getImportStatements = () => {
    return [
      ...[...imports.entries()].map(
        ([source, names]) =>
          `import { ${Object.entries(names)
            .map(([name, alias]) => `${name} as ${alias}`)
            .join(", ")} } from '${source}';`
      ),
      ...[...namespaceImports.entries()].map(
        ([source, alias]) => `import * as ${alias} from '${source}';`
      )
    ].join("\n");
  };

  return {
    addNamedImport,
    addNamespaceImport,
    getImportStatements
  };
}
