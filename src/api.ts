import { createRouter } from "radix3";

/**
 * The API dispatch adapter: matches requests against the flat manifest's
 * handler refs (`$GET`, `$POST`, …) and serves them as fetch-style
 * middleware, so API routes compose into any `(request, next)` chain — an
 * SSR handler's middleware option, a framework's request pipeline — with no
 * bundler or server involvement.
 *
 * Ported from SolidStart's `server/routes.ts` (the radix3 matcher) and the
 * method dispatch in its `server/handler.ts`.
 */

/**
 * The event a handler receives. Structurally the core request event —
 * `getRequestEvent()` inside the handler sees the same object — with the
 * matched route params written onto it before dispatch.
 */
export interface APIEvent {
  request: Request;
  params?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * An API handler: an uppercase method export of a route module. Return a
 * `Response` to answer the request; strings and JSON values are coerced
 * (`new Response(text)` / `Response.json(value)`). A `GET` handler may
 * return `undefined` to decline, falling through to the rest of the chain
 * when the module is also a page.
 */
export type APIHandler = (event: APIEvent) => unknown;

/** A manifest entry as the delivery adapter serves it. */
export interface FileRouteHandlers {
  path: string;
  page?: boolean;
  $component?: unknown;
  $HEAD?: APIHandlerRef;
  $GET?: APIHandlerRef;
  $POST?: APIHandlerRef;
  $PUT?: APIHandlerRef;
  $PATCH?: APIHandlerRef;
  $DELETE?: APIHandlerRef;
  [key: string]: unknown;
}

/**
 * A handler module ref as delivered: code-split (`import()`) by default,
 * eager (`require()`) when the delivery adapter runs with code splitting off.
 */
export type APIHandlerRef =
  { import(): Promise<Record<string, APIHandler>> } | { require(): Record<string, APIHandler> };

export interface APIMatch {
  handler: APIHandlerRef;
  params?: Record<string, string>;
  /** `true` when the module also renders a page at this path. */
  isPage: boolean;
}

function containsHTTP(route: FileRouteHandlers) {
  return route.$HEAD || route.$GET || route.$POST || route.$PUT || route.$PATCH || route.$DELETE;
}

/**
 * Builds a matcher over the flat manifest's handler-carrying entries. Route
 * paths translate from the neutral pattern language to the radix tree —
 * `(group)` segments stripped, `*rest` catch-alls, static segments
 * URL-encoded. Optional parameters are rejected (a radix tree cannot
 * represent them) and duplicate paths are a configuration error.
 */
export function createAPIMatcher(
  routes: readonly FileRouteHandlers[]
): (path: string, method: string) => APIMatch | undefined {
  const router = createRouter({
    routes: routes.reduce(
      (memo, route) => {
        if (!containsHTTP(route)) return memo;
        const path = route.path
          .replace(/\([^)/]+\)/g, "")
          .replace(/\/+/g, "/")
          .replace(/\*([^/]*)/g, (_, m) => `**:${m}`)
          .split("/")
          .map(s => (s.startsWith(":") || s.startsWith("*") ? s : encodeURIComponent(s)))
          .join("/");
        if (/:[^/]*\?/g.test(path)) {
          throw new Error(`Optional parameters are not supported in API routes: ${path}`);
        }
        if (memo[path]) {
          throw new Error(
            `Duplicate API routes for "${path}" found at "${memo[path]!.route.path}" and "${
              route.path
            }"`
          );
        }
        memo[path] = { route };
        return memo;
      },
      {} as Record<string, { route: FileRouteHandlers }>
    )
  });

  return (path, method) => {
    const match = router.lookup(path);
    if (!match || !match.route) return;
    const route = match.route;

    // A `GET` handler answers `HEAD` unless the module handles it itself.
    const handler = method === "HEAD" ? route.$HEAD || route.$GET : route[`$${method}`];
    if (handler === undefined) return;

    return {
      handler: handler as APIHandlerRef,
      params: match.params,
      isPage: route.page === true && route.$component !== undefined
    };
  };
}

/** Strips a leading path base: `stripPathBase("/app/x", "/app")` → `/x`. */
export function stripPathBase(path: string, base: string) {
  if (!base || base === "/") return path;

  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (path === normalizedBase) return "/";
  if (path.startsWith(`${normalizedBase}/`)) return path.slice(normalizedBase.length);

  return path;
}

export interface APIHandlerOptions {
  /** A path base stripped from the URL before matching. Defaults to `/`. */
  base?: string;
  /**
   * How the adapter reaches the request event it hands to handlers. Defaults
   * to the core request-event scope (the storage `provideRequestEvent`
   * establishes), which is where a middleware chain runs — override it when
   * dispatching outside one, or to hand handlers a richer event.
   */
  getEvent?: () => APIEvent;
}

const RequestContext = Symbol.for("solid.RequestContext");

function getScopedEvent(): APIEvent {
  const event = (globalThis as Record<symbol, any>)[RequestContext]?.getStore();
  if (!event) {
    throw new Error(
      "API route dispatched outside a request-event scope. Compose the handler " +
        "inside `provideRequestEvent` (any `ssr.middleware`-style chain already is), " +
        "or pass `getEvent`."
    );
  }
  return event;
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (typeof result === "string") return new Response(result);
  return Response.json(result);
}

/**
 * Fetch-style middleware serving the manifest's API routes:
 *
 * ```ts
 * import routes from "virtual:file-routes";
 * import { createAPIHandler } from "filesystem-routing/api";
 *
 * export default [createAPIHandler(routes)];
 * ```
 *
 * Dispatch preserves SolidStart's semantics: unmatched requests (no route,
 * or no handler for the method) advance the chain; `HEAD` falls back to the
 * `GET` handler; matched params are written to `event.params` before the
 * handler runs. A handler returning `undefined` declines the request —
 * allowed for `GET` only (anything else throws): a page module falls
 * through to the chain (its component renders instead), a handler-only
 * module answers 404.
 */
export function createAPIHandler(
  routes: readonly FileRouteHandlers[],
  options: APIHandlerOptions = {}
): (
  request: Request,
  next: (request?: Request) => Response | Promise<Response>
) => Promise<Response> {
  const match = createAPIMatcher(routes);
  const getEvent = options.getEvent ?? getScopedEvent;

  return async (request, next) => {
    const url = new URL(request.url);
    const matched = match(stripPathBase(url.pathname, options.base ?? "/"), request.method);
    if (!matched) return next();

    const mod =
      "require" in matched.handler ? matched.handler.require() : await matched.handler.import();
    const fn = request.method === "HEAD" ? mod.HEAD || mod.GET : mod[request.method];
    if (typeof fn !== "function") return next();

    const event = getEvent();
    event.params = matched.params || {};
    const result = await fn(event);

    if (result !== undefined) return toResponse(result);
    if (request.method !== "GET") {
      throw new Error(
        `API handler for ${request.method} "${request.url}" did not return a response.`
      );
    }
    if (!matched.isPage) return new Response(null, { status: 404 });
    return next();
  };
}
