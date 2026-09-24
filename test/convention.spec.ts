import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PageFileSystemRouter, routePathFromFile } from "../src/index.ts";

describe("routePathFromFile", () => {
  it("maps index files to their directory path", () => {
    expect(routePathFromFile("/index")).toBe("/");
    expect(routePathFromFile("/blog/index")).toBe("/blog/");
    expect(routePathFromFile("/about")).toBe("/about");
  });

  it("maps [param] segments to :param", () => {
    expect(routePathFromFile("/blog/[id]")).toBe("/blog/:id");
    expect(routePathFromFile("/[lang]/about")).toBe("/:lang/about");
  });

  it("maps [[param]] segments to optional :param?", () => {
    expect(routePathFromFile("/blog/[[page]]")).toBe("/blog/:page?");
  });

  it("maps [...rest] segments to catch-all *rest", () => {
    expect(routePathFromFile("/docs/[...path]")).toBe("/docs/*path");
  });

  it("retains group segments for emission adapters", () => {
    expect(routePathFromFile("/(marketing)/about")).toBe("/(marketing)/about");
  });

  // https://github.com/solidjs/solid-start/issues/2314
  it("only strips index as a whole segment, not as a filename suffix", () => {
    expect(routePathFromFile("/reindex")).toBe("/reindex");
    expect(routePathFromFile("/myindex")).toBe("/myindex");
    expect(routePathFromFile("/appendix")).toBe("/appendix");
    expect(routePathFromFile("/blog/reindex")).toBe("/blog/reindex");
    expect(routePathFromFile("/reindex/index")).toBe("/reindex/");
    expect(routePathFromFile("/[id]/index")).toBe("/:id/");
  });
});

const temporaryDirectories: string[] = [];

function createRouteTree(files: Record<string, string>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-routes-tree-")));
  temporaryDirectories.push(directory);
  for (const [file, source] of Object.entries(files)) {
    const filename = path.join(directory, file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});

describe("PageFileSystemRouter", () => {
  it("scans a route directory into a flat manifest", async () => {
    const dir = createRouteTree({
      "index.tsx": "export default () => <h1>Home</h1>;",
      "about.tsx": "export default () => <h1>About</h1>;",
      "blog/index.tsx": "export default () => <h1>Blog</h1>;",
      "blog/[id].tsx": `
        export const route = { preload: () => {} };
        export default () => <h1>Post</h1>;
      `,
      "docs/[...path].tsx": "export default () => <h1>Docs</h1>;",
      "not-a-page.ts": "export const helper = () => {};"
    });
    const router = new PageFileSystemRouter({ dir, extensions: ["ts", "tsx"] });

    const routes = await router.getRoutes();
    const paths = routes.map(route => route.path).sort();

    expect(paths).toEqual(["/", "/about", "/blog/", "/blog/:id", "/docs/*path"]);

    const post = routes.find(route => route.path === "/blog/:id")!;
    expect(post.page).toBe(true);
    expect(post.$component?.pick).toEqual(["default", "$css"]);
    expect(post.$$route?.pick).toEqual(["route"]);
  });

  it("keeps route files whose names end in index at their own path", async () => {
    const dir = createRouteTree({
      "reindex.tsx": "export default () => <h1>Reindex</h1>;",
      "blog/index.tsx": "export default () => <h1>Blog</h1>;",
      "blog/myindex.tsx": "export default () => <h1>My index</h1>;"
    });
    const router = new PageFileSystemRouter({ dir, extensions: ["tsx"] });

    const paths = (await router.getRoutes()).map(route => route.path).sort();

    expect(paths).toEqual(["/blog/", "/blog/myindex", "/reindex"]);
  });

  it("resolves a relative dir against the current working directory", async () => {
    const dir = createRouteTree({
      "index.tsx": "export default () => <h1>Home</h1>;",
      "blog/[id].tsx": "export default () => <h1>Post</h1>;"
    });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const router = new PageFileSystemRouter({ dir: ".", extensions: ["tsx"] });
      const paths = (await router.getRoutes()).map(route => route.path).sort();
      expect(paths).toEqual(["/", "/blog/:id"]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("updates the manifest when files change or are removed", async () => {
    const dir = createRouteTree({
      "index.tsx": "export default () => <h1>Home</h1>;"
    });
    const router = new PageFileSystemRouter({ dir, extensions: ["tsx"] });
    await router.getRoutes();

    const events: string[] = [];
    router.on("reload", evt => events.push(`${evt.detail.type}:${evt.detail.route}`));

    const contact = path.join(dir, "contact.tsx");
    fs.writeFileSync(contact, "export default () => <h1>Contact</h1>;");
    await router.addRoute(contact);
    expect(router.routes.map(route => route.path).sort()).toEqual(["/", "/contact"]);

    router.removeRoute(contact);
    expect(router.routes.map(route => route.path)).toEqual(["/"]);
    expect(events).toEqual(["add:/contact", "remove:/contact"]);
  });

  it("omits component refs when components are off", async () => {
    const dir = createRouteTree({
      "index.tsx": `
        export const route = { preload: () => {} };
        export default () => <h1>Home</h1>;
      `,
      "post.md": "# Post"
    });
    const router = new PageFileSystemRouter({
      dir,
      extensions: ["tsx", "md"],
      components: false
    });

    const routes = await router.getRoutes();

    // still routes — the config is served, the component never is
    expect(routes.map(route => route.path).sort()).toEqual(["/", "/post"]);
    expect(routes.every(route => route.$component === undefined)).toBe(true);
    expect(routes.find(route => route.path === "/")!.$$route?.pick).toEqual(["route"]);
  });

  it("picks up HTTP handler exports when http methods are on", async () => {
    const dir = createRouteTree({
      "api/health.ts": "export const GET = () => new Response('ok');",
      "api/submit.ts": `
        export const POST = () => new Response('ok');
        export const HEAD = () => new Response(null);
      `,
      "hybrid.tsx": `
        export const GET = () => new Response('ok');
        export default () => <h1>Hybrid</h1>;
      `,
      "helper.ts": "export const helper = () => {};"
    });
    const router = new PageFileSystemRouter({
      dir,
      extensions: ["ts", "tsx"],
      httpMethods: true
    });

    const routes = await router.getRoutes();
    expect(routes.map(route => route.path).sort()).toEqual([
      "/api/health",
      "/api/submit",
      "/hybrid"
    ]);

    // a handler-only module is a route without being a page
    const health = routes.find(route => route.path === "/api/health")!;
    expect(health.page).toBe(false);
    expect(health.$component).toBeUndefined();
    expect(health.$GET).toEqual({ src: expect.stringContaining("health.ts"), pick: ["GET"] });
    // `GET` answers `HEAD` unless the module handles it itself
    expect(health.$HEAD).toEqual({ src: expect.stringContaining("health.ts"), pick: ["GET"] });
    expect(routes.find(route => route.path === "/api/submit")!.$HEAD).toEqual({
      src: expect.stringContaining("submit.ts"),
      pick: ["HEAD"]
    });

    // a module can be both, and its handlers stay out of the component ref
    const hybrid = routes.find(route => route.path === "/hybrid")!;
    expect(hybrid.page).toBe(true);
    expect(hybrid.$component?.pick).toEqual(["default", "$css"]);
    expect(hybrid.$GET).toBeDefined();
  });

  it("recognizes server-function pages only with `serverComponents`", async () => {
    const files = {
      "inline.tsx": `export default async function Story({ params }) { "use server"; return () => null; }`,
      "arrow.tsx": `export default async ({ params }) => { "use server"; return () => null; };`,
      "named.tsx": `
        export const route = {};
        async function Story() { "use server"; return () => null; }
        export default Story;
      `,
      "client.tsx": `export default function Page() { return <h1 />; }`,
      "wrapped.tsx": `export default wrap(async () => { "use server"; });`
    };
    const dir = createRouteTree(files);

    // off by default: nothing changes, no module is looked at for directives
    const off = await new PageFileSystemRouter({ dir, extensions: ["tsx"] }).getRoutes();
    expect(off.every(route => route.server === undefined)).toBe(true);
    expect(off.every(route => route.$component?.eager === undefined)).toBe(true);

    const on = await new PageFileSystemRouter({
      dir,
      extensions: ["tsx"],
      serverComponents: true
    }).getRoutes();
    const byPath = Object.fromEntries(on.map(route => [route.path, route]));

    for (const path of ["/inline", "/arrow", "/named"]) {
      expect(byPath[path].page).toBe(true);
      expect(byPath[path].server).toBe(true);
      // a stub has no code worth a chunk: eager, and only the default is picked
      expect(byPath[path].$component).toEqual({
        src: expect.any(String),
        pick: ["default"],
        eager: true
      });
    }
    expect(byPath["/named"].$$route?.pick).toEqual(["route"]);
    // a client page and a default the scanner cannot see into stay as they were
    for (const path of ["/client", "/wrapped"]) {
      expect(byPath[path].server).toBeUndefined();
      expect(byPath[path].$component?.eager).toBeUndefined();
      expect(byPath[path].$component?.pick).toEqual(["default", "$css"]);
    }
  });

  it("ignores HTTP handler exports by default", async () => {
    const dir = createRouteTree({
      "api/health.ts": "export const GET = () => new Response('ok');"
    });
    const router = new PageFileSystemRouter({ dir, extensions: ["ts"] });

    expect(await router.getRoutes()).toEqual([]);
  });

  it("supports a pluggable filename convention", async () => {
    const dir = createRouteTree({
      "home.page.tsx": "export default () => <h1>Home</h1>;",
      "helper.ts": "export default () => null;"
    });
    const router = new PageFileSystemRouter({
      dir,
      extensions: ["ts", "tsx"],
      toPath: routeFile =>
        routeFile.endsWith(".page") ? routeFile.slice(0, -".page".length) : undefined
    });

    const routes = await router.getRoutes();

    expect(routes.map(route => route.path)).toEqual(["/home"]);
  });

  it("produces the manifest in a deterministic order across scans", async () => {
    const dir = createRouteTree({
      "index.tsx": "export default () => <h1>Home</h1>;",
      "about.tsx": "export default () => <h1>About</h1>;",
      "zebra.tsx": "export default () => <h1>Z</h1>;",
      "blog/index.tsx": "export default () => <h1>Blog</h1>;",
      "blog/[id].tsx": "export default () => <h1>Post</h1>;",
      "docs/[...path].tsx": "export default () => <h1>Docs</h1>;",
      "contact.tsx": "export default () => <h1>Contact</h1>;"
    });

    // Fresh router per scan — getRoutes() memoizes, so a new instance
    // forces a real re-glob each time. Map to paths but do NOT .sort().
    const scan = async () =>
      (await new PageFileSystemRouter({ dir, extensions: ["tsx"] }).getRoutes())
        .map(route => route.path);

    const first = await scan();

    // 1. Repeatable: N independent scans yield the same order.
    for (let i = 0; i < 5; i++) {
      expect(await scan()).toEqual(first);
    }

    // 2. Pin the exact order so the guarantee is explicit.
    // The sort is on source file paths (lexicographic), so the order
    // reflects that: about.tsx < blog/[id].tsx < blog/index.tsx <
    // contact.tsx < docs/[...path].tsx < index.tsx < zebra.tsx.
    expect(first).toEqual([
      "/about",
      "/blog/:id",
      "/blog/",
      "/contact",
      "/docs/*path",
      "/",
      "/zebra"
    ]);
  });
});
