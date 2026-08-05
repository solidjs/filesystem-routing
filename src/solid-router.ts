import { createComponent, lazy, onCleanup, type Component } from "solid-js";
import { acquireAsset, isServer } from "@solidjs/web";

/**
 * The Solid Router emission adapter: turns the nested `pageRoutes` view of
 * the manifest into `@solidjs/router` route definitions with code-split
 * components and a route-scoped CSS lifecycle.
 *
 * Ported from SolidStart's `router.tsx`. Like every emission adapter it
 * takes the manifest as an argument rather than importing the virtual
 * module, and the client asset manifest is a parameter for the same reason
 * — the adapter has no opinion about where either comes from.
 */

/** The client assets of one route module. */
export interface RouteAssets {
  css?: string[];
}

/**
 * Where the adapter finds a route module's client assets: a map keyed by
 * module source path, or a resolver over one. vite-plugin-solid apps pass
 * the default export of `virtual:solid-manifest/client`; other toolchains
 * pass whatever equivalent they have. Omit it (or resolve to nothing) and
 * components render unwrapped — in dev the map is empty and Vite's own
 * client manages CSS.
 */
export type RouteAssetsSource =
  Record<string, RouteAssets | undefined> | ((src: string) => RouteAssets | undefined);

/** A tree entry as the delivery adapter serves it (`pageRoutes`). */
export interface FileRoutePage {
  id: string;
  path: string;
  page?: boolean;
  $component?: { src: string; import(): Promise<Record<string, unknown>> };
  $$route?: { require(): Record<string, unknown> };
  children?: FileRoutePage[];
  [key: string]: unknown;
}

export interface FileRoutesOptions {
  /** Client asset manifest for route modules (see `RouteAssetsSource`). */
  assets?: RouteAssetsSource;
}

/**
 * A `@solidjs/router` route definition as this adapter emits it. The
 * manifest entry's own fields ride along (spread first), `route` config
 * exports are merged over them, and `info.filesystem` marks the route's
 * origin for router tooling.
 */
export interface FileRouteDefinition {
  path: string;
  component?: Component;
  children?: FileRouteDefinition[];
  info: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Ties a route's client CSS lifecycle to the route component: acquire the
 * stylesheets from the client asset manifest on mount, release on route
 * leave. `acquireAsset` ref-counts by href and adopts links however they got
 * into the document (SSR-streamed, injected by Vite's dynamic-import preload
 * helper, or created by another route sharing the stylesheet), so styles
 * from a left route are removed instead of accumulating — with a grace
 * period covering A → B → A navigation. The wrapper is applied on both
 * server and client so the component tree (and with it hydration ids) stays
 * aligned.
 */
export function withRouteAssets(
  src: string,
  component: Component,
  assets?: RouteAssetsSource
): Component {
  const entry =
    typeof assets === "function" ? assets(src.split("?")[0]!) : assets?.[src.split("?")[0]!];
  if (!entry?.css?.length) return component;
  const wrapped: Component & { preload?: unknown } = props => {
    if (!isServer) {
      for (const href of entry.css!) {
        onCleanup(acquireAsset({ type: "style", href }));
      }
    }
    return createComponent(component, props as any);
  };
  // Routers drive `preload` (navigation intent) and islands read `moduleUrl`
  // off the component — forward both from the underlying lazy component.
  wrapped.preload = (component as any).preload;
  Object.defineProperty(wrapped, "moduleUrl", {
    get: () => (component as any).moduleUrl
  });
  return wrapped;
}

/**
 * The file-system route tree, shaped as `@solidjs/router` route definitions.
 * Pass the manifest's nested view and get routes for the router factory:
 *
 * ```ts
 * import { pageRoutes } from "virtual:file-routes";
 * import clientAssets from "virtual:solid-manifest/client";
 *
 * createRouter({ routes: fileRoutes(pageRoutes, { assets: clientAssets }) });
 * ```
 *
 * Components are code-split (`lazy` over the manifest's dynamic-import
 * refs), deduplicated by source path so routes sharing a module share one
 * component (and one CSS lifecycle), and wrapped with the route-CSS
 * lifecycle when `assets` resolves stylesheets for them. Routes are
 * immutable per router instance, so one shared tree serves every request
 * and mount.
 */
export function fileRoutes(
  pageRoutes: readonly FileRoutePage[],
  options: FileRoutesOptions = {}
): FileRouteDefinition[] {
  const components: Record<string, Component> = {};

  function createRoute(route: FileRoutePage): FileRouteDefinition {
    const component =
      route.$component &&
      (components[route.$component.src] ??= withRouteAssets(
        route.$component.src,
        lazy(route.$component.import as any, route.$component.src),
        options.assets
      ));

    const config = route.$$route ? (route.$$route.require().route as any) : undefined;

    return {
      ...route,
      ...config,
      info: {
        ...(config ? config.info : {}),
        filesystem: true
      },
      component,
      children: route.children ? route.children.map(createRoute) : undefined
    };
  }

  return pageRoutes.map(createRoute);
}
