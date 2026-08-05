import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PageFileSystemRouter } from "../src/convention.ts";
import type { ModuleRef, RouteManifestEntry } from "../src/manifest.ts";
import { buildRouteTree } from "../src/tree.ts";
import { createAPIHandler, type APIEvent } from "../src/api.ts";
import { fileRoutes } from "../src/solid-router.ts";

// Both adapters against a real scan: route modules on disk, the shipping
// convention over them, refs materialized the way the Vite delivery adapter
// materializes them (`$` → dynamic import, `$$` → eager require) — the
// virtual-module serialization itself is pinned by vite.spec.ts.

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-routes-adapters-")));

const files: Record<string, string> = {
  "index.mjs": `export default () => "home";`,
  "(admin).mjs": `export default props => "admin-layout";`,
  "(admin)/stats.mjs": `
    export const route = { info: { tag: "stats" } };
    export default () => "stats";
  `,
  "about.mjs": `
    export default () => "about";
    export const GET = event => (event.wantsPage ? undefined : new Response("about-data"));
  `,
  "api/users/[id].mjs": `
    export const GET = event => Response.json({ id: event.params.id });
    export const POST = async event => new Response(await event.request.text(), { status: 201 });
  `
};

for (const [file, source] of Object.entries(files)) {
  const filename = path.join(directory, file);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source);
}

afterAll(() => {
  fs.rmSync(directory, { recursive: true });
});

/** Materializes manifest refs the way the delivery adapter's output behaves. */
async function materialize(routes: RouteManifestEntry[]) {
  const delivered = [];
  for (const route of routes) {
    const entry: Record<string, unknown> = { ...route };
    for (const [key, value] of Object.entries(route)) {
      if (!value || !key.startsWith("$")) continue;
      const ref = value as ModuleRef;
      if (key.startsWith("$$")) {
        const mod = await import(ref.src);
        entry[key] = {
          require: () => Object.fromEntries(ref.pick.map(pick => [pick, mod[pick]]))
        };
      } else {
        entry[key] = { src: ref.src, import: () => import(ref.src) };
      }
    }
    delivered.push(entry);
  }
  return delivered as any[];
}

async function scan() {
  const router = new PageFileSystemRouter({
    dir: directory,
    extensions: ["mjs"],
    httpMethods: true
  });
  return materialize(await router.getRoutes());
}

describe("adapters over a real scan", () => {
  it("emits the nested route tree with groups stripped and configs merged", async () => {
    const delivered = await scan();
    const tree = buildRouteTree(delivered.filter(entry => entry.page));
    const routes = fileRoutes(tree);

    const paths = routes.map(route => route.path).sort();
    expect(paths).toEqual(["/", "/", "/about"]);

    // the group layout nests its child at the stripped path
    const layout = routes.find(route => route.id === "/(admin)")!;
    expect(layout.path).toBe("/");
    expect(layout.children!.map(child => child.path)).toEqual(["/stats"]);
    // the eager `route` config merged in, info tagged with its origin
    expect(layout.children![0]!.info).toEqual({ tag: "stats", filesystem: true });
    // components are code-split lazy refs with preload
    expect(typeof layout.children![0]!.component).toBe("function");
    expect(typeof (layout.children![0]!.component as any).preload).toBe("function");
  });

  it("dispatches API routes from the same manifest", async () => {
    const delivered = await scan();
    let event: APIEvent;
    const handler = createAPIHandler(delivered, { getEvent: () => event });
    const dispatch = (request: Request, extra: Record<string, unknown> = {}) => {
      event = { request, ...extra };
      return handler(request, () => Promise.resolve(new Response("rendered")));
    };

    // params flow from the URL through the matcher onto the event
    const get = await dispatch(new Request("http://test/api/users/42"));
    expect(await get.json()).toEqual({ id: "42" });

    const post = await dispatch(
      new Request("http://test/api/users/42", { method: "POST", body: "payload" })
    );
    expect(post.status).toBe(201);
    expect(await post.text()).toBe("payload");

    // HEAD rides the GET handler via the convention's alias ref
    const head = await dispatch(new Request("http://test/about", { method: "HEAD" }));
    expect(await head.text()).toBe("about-data");

    // a page module's GET may decline and fall through to rendering
    const declined = await dispatch(new Request("http://test/about"), { wantsPage: true });
    expect(await declined.text()).toBe("rendered");

    // pages without handlers never enter the matcher
    const page = await dispatch(new Request("http://test/"));
    expect(await page.text()).toBe("rendered");
  });
});
