import { analyzeRouteModule, getExportName, getLocalExportName } from "./analyze.ts";
import type { ModuleRef, RouteManifestEntry } from "./manifest.ts";
import { BaseFileSystemRouter, cleanPath, type FileSystemRouterConfig } from "./router.ts";

/**
 * The filename convention proven by SolidStart:
 * - `index` files map to their directory's path
 * - `[param]` maps to `:param`
 * - `[[param]]` maps to an optional `:param?`
 * - `[...rest]` maps to a catch-all `*rest`
 * - `(group)` segments are retained for emission adapters to nest and strip
 */
export function routePathFromFile(routeFile: string): string {
  const routePath = routeFile
    // remove the initial slash
    .slice(1)
    // only strip a whole `index` segment, not a name that merely ends in "index" (e.g. `reindex`)
    .replace(/(^|\/)index$/, "$1")
    .replace(/\[([^/]+)\]/g, (_, m) => {
      if (m.length > 3 && m.startsWith("...")) {
        return `*${m.slice(3)}`;
      }
      if (m.length > 2 && m.startsWith("[") && m.endsWith("]")) {
        return `:${m.slice(1, -1)}?`;
      }
      return `:${m}`;
    });

  return routePath?.length > 0 ? `/${routePath}` : "/";
}

/**
 * The HTTP methods a route module may export as a request handler. Enabled
 * per-router via `httpMethods`; frameworks that do not serve requests from
 * route modules (a client manifest, a static site) leave it off.
 */
export const HTTP_METHODS = ["HEAD", "GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;

export interface PageFileSystemRouterConfig extends FileSystemRouterConfig {
  /**
   * Emit `$component` refs for pages. Set to `false` for manifests that
   * route without rendering — a server manifest in SPA mode, where the
   * client owns every component — so page modules stay out of that bundle.
   * Defaults to `true`.
   */
  components?: boolean;
  /**
   * Treat these uppercase exports as request handlers, emitting a `$GET`,
   * `$POST`, … ref for each (and a `$HEAD` alias for a lone `GET`). A module
   * with handlers but no default export is a route without being a page.
   * Pass `true` for the standard set. Defaults to `false`.
   */
  httpMethods?: boolean | readonly string[];
  /**
   * Recognize server-function pages: a default export whose body begins with
   * a `"use server"` directive is flagged `server: true` and its `$component`
   * delivered eagerly — the client side of such a module is a stub, not a
   * chunk's worth of component. What a server-rendered page means is the
   * emission adapter's business. Defaults to `false`.
   */
  serverComponents?: boolean;
}

function httpMethodsOf(config: PageFileSystemRouterConfig): readonly string[] {
  if (!config.httpMethods) return [];
  return config.httpMethods === true ? HTTP_METHODS : config.httpMethods;
}

function createHandlerRefs(src: string, exports: readonly string[], methods: readonly string[]) {
  const handlers: Record<string, ModuleRef> = {};
  for (const method of methods) {
    if (!exports.includes(method)) continue;
    handlers[`$${method}`] = { src, pick: [method] };
  }
  // A `GET` handler answers `HEAD` unless the module handles it itself.
  if (handlers.$GET && !handlers.$HEAD && methods.includes("HEAD")) {
    handlers.$HEAD = { src, pick: ["GET"] };
  }
  return handlers;
}

/**
 * The module convention proven by SolidStart: a route module is a page when
 * it has a default export, may export a `route` config object, and — when
 * `httpMethods` is on — may export `GET`, `POST`, … request handlers.
 * `.md`/`.mdx` files are always pages.
 */
export class PageFileSystemRouter extends BaseFileSystemRouter {
  declare config: PageFileSystemRouterConfig;

  constructor(config: PageFileSystemRouterConfig) {
    super(config);
  }

  toPath(src: string): string | undefined {
    if (this.config.toPath) return super.toPath(src);
    return routePathFromFile(cleanPath(src, this.config));
  }

  toRoute(src: string): RouteManifestEntry | undefined {
    if (this.config.toRoute) return super.toRoute(src);

    const path = this.toPath(src);
    if (path === undefined) return;

    const components = this.config.components ?? true;

    if (src.endsWith(".md") || src.endsWith(".mdx")) {
      return {
        page: true,
        $component: components
          ? {
              src: src,
              pick: ["$css"]
            }
          : undefined,
        $$route: undefined,
        path
      };
    }

    const methods = httpMethodsOf(this.config);
    const { exports, defaultDirective } = analyzeRouteModule(src);
    const exportNames = exports.map(getExportName);
    const localExportNames = exports.map(getLocalExportName).filter(name => name !== undefined);
    const hasDefault = exportNames.includes("default");
    const hasRouteConfig = exportNames.includes("route");
    const handlers = createHandlerRefs(src, exportNames, methods);
    const hasHandlers = Object.keys(handlers).length > 0;
    // A server-function page (opt-in): the client gets a stub, not a chunk's
    // worth of component, so it is delivered eagerly and flagged for the adapter.
    const server =
      this.config.serverComponents === true && hasDefault && defaultDirective === "use server";

    if (hasDefault || hasHandlers) {
      return {
        page: hasDefault,
        ...(server ? { server } : {}),
        $component:
          components && hasDefault
            ? {
                src: src,
                pick: server
                  ? ["default"]
                  : [
                      ...localExportNames.filter(
                        name => name !== "route" && !methods.includes(name)
                      ),
                      "default",
                      "$css"
                    ],
                ...(server ? { eager: true } : {})
              }
            : undefined,
        $$route: hasRouteConfig
          ? {
              src: src,
              pick: ["route"]
            }
          : undefined,
        ...handlers,
        path
      };
    }
  }
}
