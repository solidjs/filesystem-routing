import { describe, expect, it, vi } from "vitest";

import {
  createAPIHandler,
  createAPIMatcher,
  stripPathBase,
  type APIEvent,
  type FileRouteHandlers
} from "../src/api.ts";

const ref = (handlers: Record<string, (event: APIEvent) => unknown>) => ({
  import: () => Promise.resolve(handlers)
});

const next = () => Promise.resolve(new Response("rendered", { status: 200 }));

describe("createAPIMatcher", () => {
  it("matches static and parameterized paths, ignoring handler-less entries", () => {
    const match = createAPIMatcher([
      { path: "/", page: true },
      { path: "/api/posts/:id", $GET: ref({}) }
    ]);

    expect(match("/", "GET")).toBeUndefined();
    expect(match("/api/posts/42", "GET")?.params).toEqual({ id: "42" });
    expect(match("/api/missing", "GET")).toBeUndefined();
  });

  it("matches catch-alls across segments", () => {
    const match = createAPIMatcher([{ path: "/files/*path", $GET: ref({}) }]);
    expect(match("/files/a/b/c.txt", "GET")?.params).toEqual({ path: "a/b/c.txt" });
  });

  it("strips group segments before matching", () => {
    const match = createAPIMatcher([{ path: "/(admin)/api/stats", $GET: ref({}) }]);
    expect(match("/api/stats", "GET")).toBeDefined();
    expect(match("/(admin)/api/stats", "GET")).toBeUndefined();
  });

  it("returns no match for methods the module does not handle", () => {
    const match = createAPIMatcher([{ path: "/api/thing", $GET: ref({}) }]);
    expect(match("/api/thing", "POST")).toBeUndefined();
  });

  it("falls back HEAD to the GET handler", () => {
    const getRef = ref({});
    const match = createAPIMatcher([{ path: "/api/thing", $GET: getRef }]);
    expect(match("/api/thing", "HEAD")?.handler).toBe(getRef);

    const headRef = ref({});
    const own = createAPIMatcher([{ path: "/api/thing", $GET: getRef, $HEAD: headRef }]);
    expect(own("/api/thing", "HEAD")?.handler).toBe(headRef);
  });

  it("flags modules that are also pages", () => {
    const match = createAPIMatcher([
      { path: "/about", page: true, $component: {}, $GET: ref({}) },
      { path: "/api/data", $GET: ref({}) }
    ]);
    expect(match("/about", "GET")?.isPage).toBe(true);
    expect(match("/api/data", "GET")?.isPage).toBe(false);
  });

  it("rejects optional parameters and duplicate paths", () => {
    expect(() => createAPIMatcher([{ path: "/api/:page?", $GET: ref({}) }])).toThrow(
      /Optional parameters/
    );
    expect(() =>
      createAPIMatcher([
        { path: "/(a)/api/thing", $GET: ref({}) },
        { path: "/api/thing", $GET: ref({}) }
      ])
    ).toThrow(/Duplicate API routes/);
  });
});

describe("stripPathBase", () => {
  it("strips a leading base, normalizing trailing slashes", () => {
    expect(stripPathBase("/app/x", "/app")).toBe("/x");
    expect(stripPathBase("/app/x", "/app/")).toBe("/x");
    expect(stripPathBase("/app", "/app")).toBe("/");
    expect(stripPathBase("/apple", "/app")).toBe("/apple");
    expect(stripPathBase("/x", "/")).toBe("/x");
    expect(stripPathBase("/x", "")).toBe("/x");
  });
});

describe("createAPIHandler", () => {
  const dispatch = (
    routes: FileRouteHandlers[],
    request: Request,
    options: Parameters<typeof createAPIHandler>[1] = {}
  ) => {
    const event: APIEvent = { request };
    const handler = createAPIHandler(routes, { getEvent: () => event, ...options });
    return { response: handler(request, next), event };
  };

  it("advances the chain for unmatched requests", async () => {
    const chain = vi.fn(next);
    const handler = createAPIHandler([{ path: "/api/thing", $GET: ref({}) }], {
      getEvent: () => ({ request: new Request("http://test/other") })
    });
    const response = await handler(new Request("http://test/other"), chain);
    expect(chain).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("rendered");
  });

  it("dispatches with params on the event", async () => {
    const routes = [
      {
        path: "/api/posts/:id",
        $GET: ref({ GET: event => Response.json({ id: event.params!.id }) })
      }
    ];
    const { response, event } = dispatch(routes, new Request("http://test/api/posts/42"));
    expect(await (await response).json()).toEqual({ id: "42" });
    expect(event.params).toEqual({ id: "42" });
  });

  it("coerces string and JSON returns into responses", async () => {
    const routes = [
      { path: "/api/text", $GET: ref({ GET: () => "plain" }) },
      { path: "/api/json", $GET: ref({ GET: () => ({ ok: true }) }) }
    ];
    const text = await dispatch(routes, new Request("http://test/api/text")).response;
    expect(await text.text()).toBe("plain");
    const json = await dispatch(routes, new Request("http://test/api/json")).response;
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toEqual({ ok: true });
  });

  it("serves HEAD through the GET handler", async () => {
    const routes = [{ path: "/api/thing", $GET: ref({ GET: () => new Response("get-body") }) }];
    const { response } = dispatch(routes, new Request("http://test/api/thing", { method: "HEAD" }));
    expect(await (await response).text()).toBe("get-body");
  });

  it("throws when a non-GET handler declines", async () => {
    const routes = [{ path: "/api/thing", $POST: ref({ POST: () => undefined }) }];
    const { response } = dispatch(routes, new Request("http://test/api/thing", { method: "POST" }));
    await expect(response).rejects.toThrow(/did not return a response/);
  });

  it("falls through to the chain when a page's GET declines, 404s otherwise", async () => {
    const asPage = [
      { path: "/about", page: true, $component: {}, $GET: ref({ GET: () => undefined }) }
    ];
    const fellThrough = await dispatch(asPage, new Request("http://test/about")).response;
    expect(await fellThrough.text()).toBe("rendered");

    const handlerOnly = [{ path: "/api/thing", $GET: ref({ GET: () => undefined }) }];
    const notFound = await dispatch(handlerOnly, new Request("http://test/api/thing")).response;
    expect(notFound.status).toBe(404);
  });

  it("strips the configured base before matching", async () => {
    const routes = [{ path: "/api/thing", $GET: ref({ GET: () => new Response("ok") }) }];
    const { response } = dispatch(routes, new Request("http://test/app/api/thing"), {
      base: "/app"
    });
    expect(await (await response).text()).toBe("ok");
  });

  it("reads the event from the request-event scope by default", async () => {
    const routes = [
      { path: "/api/whoami", $GET: ref({ GET: event => new Response(String(event.user)) }) }
    ];
    const handler = createAPIHandler(routes);
    const scope = Symbol.for("solid.RequestContext");
    const event = { request: new Request("http://test/api/whoami"), user: "scoped" };

    (globalThis as any)[scope] = { getStore: () => event };
    try {
      const response = await handler(event.request, next);
      expect(await response.text()).toBe("scoped");
      expect((event as any).params).toEqual({});
    } finally {
      delete (globalThis as any)[scope];
    }

    await expect(createAPIHandler(routes)(event.request, next)).rejects.toThrow(
      /request-event scope/
    );
  });
});
