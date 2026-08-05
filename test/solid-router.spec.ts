import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fileRoutes, withRouteAssets, type FileRoutePage } from "../src/solid-router.ts";

// The adapter's client/server split rides on `isServer`, and the CSS
// lifecycle on `acquireAsset` — mock the module so tests drive both sides
// (the ref-counting/grace-period behavior behind `acquireAsset` is the
// runtime's, tested there; what is under test here is the wrapper's
// acquire-on-mount / release-on-leave plumbing).
const web = vi.hoisted(() => ({
  isServer: false,
  released: [] as string[],
  acquireAsset: vi.fn(
    (descriptor: { type: string; href: string }) => () => web.released.push(descriptor.href)
  )
}));

vi.mock("@solidjs/web", () => ({
  get isServer() {
    return web.isServer;
  },
  acquireAsset: web.acquireAsset
}));

beforeEach(() => {
  web.isServer = false;
  web.released.length = 0;
  web.acquireAsset.mockClear();
});

const component = (marker: string) => {
  const fn = (props: any) => `${marker}:${props?.label ?? ""}`;
  return fn as any;
};

describe("withRouteAssets", () => {
  it("returns the component untouched when no assets resolve", () => {
    const bare = component("page");
    expect(withRouteAssets("/routes/index.tsx", bare)).toBe(bare);
    expect(withRouteAssets("/routes/index.tsx", bare, {})).toBe(bare);
    expect(withRouteAssets("/routes/index.tsx", bare, { "/routes/index.tsx": { css: [] } })).toBe(
      bare
    );
  });

  it("acquires each stylesheet on mount and releases on route leave", () => {
    const wrapped = withRouteAssets("/routes/index.tsx", component("page"), {
      "/routes/index.tsx": { css: ["/a.css", "/b.css"] }
    });

    createRoot(dispose => {
      const rendered = (wrapped as any)({ label: "x" });
      expect(rendered).toBe("page:x");
      expect(web.acquireAsset.mock.calls.map(([d]) => d)).toEqual([
        { type: "style", href: "/a.css" },
        { type: "style", href: "/b.css" }
      ]);
      expect(web.released).toEqual([]);

      dispose();
    });
    expect(web.released).toEqual(["/a.css", "/b.css"]);
  });

  it("wraps on the server too — without touching assets — so hydration ids align", () => {
    web.isServer = true;
    const bare = component("page");
    const wrapped = withRouteAssets("/routes/index.tsx", bare, {
      "/routes/index.tsx": { css: ["/a.css"] }
    });

    expect(wrapped).not.toBe(bare);
    expect((wrapped as any)({ label: "s" })).toBe("page:s");
    expect(web.acquireAsset).not.toHaveBeenCalled();
  });

  it("looks assets up by query-stripped source path, through a map or a resolver", () => {
    const resolver = vi.fn((src: string) =>
      src === "/routes/post.tsx" ? { css: ["/post.css"] } : undefined
    );

    const viaResolver = withRouteAssets(
      "/routes/post.tsx?pick=default&pick=$css",
      component("post"),
      resolver
    );
    expect(resolver).toHaveBeenCalledWith("/routes/post.tsx");
    createRoot(dispose => {
      (viaResolver as any)({});
      dispose();
    });
    expect(web.released).toEqual(["/post.css"]);

    const viaMap = withRouteAssets("/routes/post.tsx?pick=default", component("post"), {
      "/routes/post.tsx": { css: ["/post.css"] }
    });
    expect(viaMap).not.toBe(component("post"));
  });

  it("forwards preload and moduleUrl from the underlying lazy component", () => {
    const bare = component("page");
    bare.preload = () => "preloaded";
    let url = "/routes/index.tsx";
    Object.defineProperty(bare, "moduleUrl", { get: () => url });

    const wrapped = withRouteAssets("/routes/index.tsx", bare, {
      "/routes/index.tsx": { css: ["/a.css"] }
    }) as any;

    expect(wrapped.preload).toBe(bare.preload);
    expect(wrapped.moduleUrl).toBe("/routes/index.tsx");
    url = "/assets/index-hash.js";
    // live: islands read it after the client manifest resolves
    expect(wrapped.moduleUrl).toBe("/assets/index-hash.js");
  });
});

describe("fileRoutes", () => {
  const page = (path: string, src: string, extra: Partial<FileRoutePage> = {}): FileRoutePage => ({
    id: path,
    path,
    page: true,
    $component: { src, import: () => Promise.resolve({ default: component(src) }) },
    ...extra
  });

  it("emits route definitions with code-split components", () => {
    const routes = fileRoutes([page("/", "/routes/index.tsx")]);

    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toBe("/");
    expect(routes[0]!.info).toEqual({ filesystem: true });
    expect(typeof routes[0]!.component).toBe("function");
    // lazy components carry `preload`; the router drives it on navigation intent
    expect(typeof (routes[0]!.component as any).preload).toBe("function");
    expect(routes[0]!.children).toBeUndefined();
  });

  it("deduplicates components by source path, sharing one CSS lifecycle", () => {
    const routes = fileRoutes(
      [page("/a", "/routes/shared.tsx"), page("/b", "/routes/shared.tsx")],
      { assets: { "/routes/shared.tsx": { css: ["/shared.css"] } } }
    );

    expect(routes[0]!.component).toBe(routes[1]!.component);
  });

  it("merges eager route config over the entry, keeping info.filesystem", () => {
    const preload = () => {};
    const routes = fileRoutes([
      page("/blog/:id", "/routes/blog/[id].tsx", {
        $$route: { require: () => ({ route: { preload, info: { tag: "blog" } } }) }
      })
    ]);

    expect(routes[0]!.preload).toBe(preload);
    expect(routes[0]!.info).toEqual({ tag: "blog", filesystem: true });
  });

  it("maps children recursively, preserving the nested view's relative paths", () => {
    const routes = fileRoutes([
      {
        ...page("/", "/routes/(app).tsx"),
        id: "/(app)",
        children: [page("/dashboard", "/routes/(app)/dashboard.tsx")]
      }
    ]);

    expect(routes[0]!.path).toBe("/");
    expect(routes[0]!.children).toHaveLength(1);
    expect(routes[0]!.children![0]!.path).toBe("/dashboard");
    expect(routes[0]!.children![0]!.info).toEqual({ filesystem: true });
  });

  it("emits componentless definitions for entries without a component ref", () => {
    const routes = fileRoutes([{ id: "/api", path: "/api" }]);
    expect(routes[0]!.component).toBeUndefined();
  });
});
