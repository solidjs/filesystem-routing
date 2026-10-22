import fg from "fast-glob";
import micromatch from "micromatch";
import { posix, resolve, sep } from "node:path";

import type { RouteManifestEntry } from "./manifest.ts";

export const glob = (path: string) => fg.sync(path, { absolute: true });

/** Normalize a file path to posix separators (bundler-agnostic). */
export function normalizePath(path: string) {
  return sep === "\\" ? path.replace(/\\/g, "/") : path;
}

export interface FileSystemRouterConfig {
  /**
   * Route directory to scan. Relative paths are resolved against the
   * current working directory.
   */
  dir: string;
  /** File extensions (without the dot) that participate in routing. */
  extensions: string[];
  /**
   * Pluggable filename convention: maps a route file (relative to `dir`,
   * extension stripped, e.g. `/blog/[id]`) to a route path in the neutral
   * pattern language, or `undefined` to skip the file. When omitted, the
   * router's own `toPath` implementation is used.
   */
  toPath?: (routeFile: string, config: FileSystemRouterConfig) => string | undefined;
  /**
   * Pluggable module convention: maps a source file to a manifest entry,
   * or `undefined` to skip the file. When omitted, the router's own
   * `toRoute` implementation is used.
   */
  toRoute?: (src: string, router: BaseFileSystemRouter) => RouteManifestEntry | undefined;
}

type RouterEvent = CustomEvent<{ route: string; type: "update" | "remove" | "add" }>;

/** Strips the route dir prefix and the file extension from a source path. */
export function cleanPath(src: string, config: FileSystemRouterConfig) {
  return src
    .slice(config.dir.length)
    .replace(new RegExp(`\.(${(config.extensions ?? []).join("|")})$`), "");
}

/**
 * Bundler-agnostic file-system router: scans a directory into a flat, neutral
 * route manifest and keeps it up to date as files are added, changed and
 * removed. Delivery adapters (e.g. the Vite plugin) subscribe to `reload`
 * events; emission adapters consume the manifest.
 */
export class BaseFileSystemRouter extends EventTarget {
  routes: RouteManifestEntry[];

  /** Source file that first produced each route path, so incremental changes keep scan order. */
  private sources = new Map<string, string>();

  config: FileSystemRouterConfig;

  /**
   * Route path each source file produced. A removed file can no longer be
   * passed to `toRoute`, and `toPath` may give another file's route.
   */
  private routePaths = new Map<string, string>();

  constructor(config: FileSystemRouterConfig) {
    super();
    this.routes = [];
    // A relative dir would glob fine, but the matched files come back
    // absolute and would then fail `isRoute`'s micromatch against the
    // relative pattern, silently yielding zero routes.
    this.config = { ...config, dir: normalizePath(resolve(config.dir)) };
  }

  glob() {
    const extensions = this.config.extensions;
    // a single-entry brace pattern like `.{tsx}` is treated as a literal
    const suffix = extensions.length === 1 ? `.${extensions[0]}` : `.{${extensions.join(",")}}`;
    return posix.join(fg.convertPathToPattern(this.config.dir), "**/*") + suffix;
  }

  async buildRoutes(): Promise<RouteManifestEntry[]> {
    for (const src of glob(this.glob()).sort()) {
      await this.addRoute(src);
    }

    return this.routes;
  }

  isRoute(src: string) {
    return Boolean(micromatch(src as any, this.glob())?.length);
  }

  toPath(src: string): string | undefined {
    if (this.config.toPath) return this.config.toPath(cleanPath(src, this.config), this.config);
    throw new Error("Not implemented");
  }

  toRoute(src: string): RouteManifestEntry | undefined {
    if (this.config.toRoute) return this.config.toRoute(src, this);
    throw new Error("Not implemented");
  }

  _addRoute(route: RouteManifestEntry, src?: string) {
    const idx = this.routes.findIndex(r => r.path === route.path);
    if (idx >= 0) {
      // Replace in place: an edited file keeps its position. The source that
      // first produced the path still decides it, as in a full scan.
      this.routes[idx] = route;
      return true;
    }

    if (src !== undefined) this.sources.set(route.path, src);

    // A new file goes where a full scan would put it.
    const at =
      src === undefined
        ? -1
        : this.routes.findIndex(r => {
            const other = this.sources.get(r.path);
            return other !== undefined && other > src;
          });
    if (at === -1) this.routes.push(route);
    else this.routes.splice(at, 0, route);

    return false;
  }

  async addRoute(src: string) {
    src = normalizePath(src);
    if (this.isRoute(src)) {
      try {
        const route = this.toRoute(src);
        if (route) {
          if (this.routePaths.get(src) !== route.path) this.removeRoute(src);
          this._addRoute(route, src);
          this.routePaths.set(src, route.path);
          this.reload(route.path, "add");
        }
      } catch (e) {
        console.error(e);
      }
    }
  }

  reload(route: string, type: "update" | "remove" | "add") {
    this.dispatchEvent(
      new CustomEvent("reload", {
        detail: {
          route,
          type
        }
      })
    );
  }

  async updateRoute(src_: string) {
    const src = normalizePath(src_);
    if (this.isRoute(src)) {
      try {
        const route = this.toRoute(src);
        if (route) {
          if (this.routePaths.get(src) !== route.path) this.removeRoute(src_);
          const updated = this._addRoute(route, src);
          this.routePaths.set(src, route.path);
          this.reload(route.path, updated ? "update" : "add");
        } else {
          this.removeRoute(src_);
        }
      } catch (e) {
        console.error(e);
      }
    }
  }

  removeRoute(src: string) {
    src = normalizePath(src);
    const path = this.routePaths.get(src);
    if (path === undefined) return;
    this.routePaths.delete(src);

    const idx = this.routes.findIndex(r => r.path === path);
    if (idx === -1) return;

    this.routes.splice(idx, 1);
    this.sources.delete(path);
    this.reload(path, "remove");
  }

  on(type: string, cb: (evt: RouterEvent) => void) {
    this.addEventListener(type, cb as any);
    return () => this.removeEventListener(type, cb as any);
  }

  buildRoutesPromise?: Promise<RouteManifestEntry[]>;

  async getRoutes() {
    if (!this.buildRoutesPromise) {
      this.buildRoutesPromise = this.buildRoutes();
    }
    await this.buildRoutesPromise;
    return this.routes;
  }
}
