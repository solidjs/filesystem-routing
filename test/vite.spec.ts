import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageFileSystemRouter } from "../src/convention.ts";
import { fileRoutes, moduleId, writeRouteTypes } from "../src/vite/index.ts";

const temporaryDirectories: string[] = [];

function createRouteTree(files: Record<string, string>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-routes-vite-")));
  temporaryDirectories.push(directory);
  for (const [file, source] of Object.entries(files)) {
    const filename = path.join(directory, "src", "routes", file);
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

function createPlugin(root: string, options: Parameters<typeof fileRoutes>[0] = {}) {
  const [plugin] = fileRoutes(options) as any[];
  plugin.configResolved({ root });
  return plugin;
}

function loadWith(plugin: any, root: string, environment = "client", consumer?: string) {
  const context = {
    environment: { config: { root, consumer }, mode: "dev", name: environment }
  };
  return plugin.load.call(context, moduleId);
}

function loadVirtualModule(root: string, environment = "client") {
  return loadWith(createPlugin(root), root, environment);
}

describe("writeRouteTypes", () => {
  it("generates the same literal tuples as the plugin without running Vite", async () => {
    const root = createRouteTree({
      "(app).tsx": "export default props => <main>{props.children}</main>;",
      "(app)/index.tsx": "export default () => <h1>Home</h1>;",
      "(app)/users/[id].tsx": "export default () => <h1>User</h1>;",
      "(app)/[...404].tsx": "export default () => <h1>Not found</h1>;",
      "(app)/users/helper.ts": "export const helper = () => {};"
    });

    expect(await writeRouteTypes({ root })).toBe(true);
    const declaration = fs.readFileSync(path.join(root, "file-routes.d.ts"), "utf-8");
    expect(declaration).toContain('declare module "virtual:file-routes"');
    expect(declaration).toMatch(/const routes: readonly \[/);
    expect(declaration).toMatch(/export const pageRoutes: readonly \[/);
    expect(declaration).toContain('path: "/(app)"');
    expect(declaration).toMatch(/children: readonly \[[\s\S]*path: "\/users\/:id"/);
    expect(declaration).toContain('path: "/*404"');
    expect(declaration).not.toContain("helper");

    await createPlugin(root, { types: "plugin.d.ts" }).buildStart.call({});
    expect(fs.readFileSync(path.join(root, "plugin.d.ts"), "utf-8")).toBe(declaration);
  });

  it.each([true, false])("matches plugin options with codeSplitting: %s", async codeSplitting => {
    const root = createRouteTree({
      "index.tsx": "export default () => <h1>Home</h1>;",
      "story.tsx": 'export default async function Story() { "use server"; return () => null; }',
      "api.ts": "export const GET = () => new Response('ok');",
      "post.md": "# Post",
      "excluded.jsx": "export default () => <h1>Excluded</h1>;"
    });
    const options = {
      dir: "src/routes",
      extensions: ["ts", "tsx", "md"],
      httpMethods: ["GET"],
      serverComponents: true,
      moduleId: "virtual:custom-routes",
      codeSplitting
    };
    await writeRouteTypes({ root, ...options, file: "types/routes.d.ts" });
    const declaration = fs.readFileSync(path.join(root, "types/routes.d.ts"), "utf-8");
    expect(declaration).toContain('declare module "virtual:custom-routes"');
    expect(declaration).toMatch(/server: true;\s*\n\s*\$component: FileRouteEagerRef/);
    expect(declaration).toContain("$GET:");
    expect(declaration).not.toContain("$HEAD:");
    expect(declaration).not.toContain("excluded");
    expect(declaration).toContain('typeof import("../src/routes/index")');
    expect(declaration).toContain(
      `$component: FileRoute${codeSplitting ? "Lazy" : "Eager"}Ref<typeof import("../src/routes/index")>`
    );

    await createPlugin(root, { ...options, types: "types/plugin.d.ts" }).buildStart.call({});
    expect(fs.readFileSync(path.join(root, "types/plugin.d.ts"), "utf-8")).toBe(declaration);
  });

  it("uses the current directory as the default root", async () => {
    const root = createRouteTree({ "index.ts": "export default () => 'home';" });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      await writeRouteTypes();
      expect(fs.readFileSync(path.join(root, "file-routes.d.ts"), "utf-8")).toContain('path: "/"');
    } finally {
      cwd.mockRestore();
    }
  });

  it("uses a custom router instead of the scan options", async () => {
    const root = createRouteTree({ "index.tsx": "export default () => <h1>Home</h1>;" });
    const router = new PageFileSystemRouter({
      dir: path.join(root, "src/routes"),
      extensions: ["tsx"],
      toPath: () => "/custom",
      components: false
    });
    const file = path.join(root, "types/custom.d.ts");

    await writeRouteTypes({ router, file, dir: "unused", extensions: [] });
    const declaration = fs.readFileSync(file, "utf-8");
    expect(declaration).toContain('path: "/custom"');
    expect(declaration).not.toContain("$component:");
  });

  it("accepts a custom directory and convention", async () => {
    const root = createRouteTree({ "index.ts": "export default () => 'home';" });
    await writeRouteTypes({
      root,
      dir: "src",
      toPath: file => `/custom${file}`,
      toRoute: (src, router) => ({ path: `${router.toPath(src)}/from-to-route`, page: true })
    });
    expect(fs.readFileSync(path.join(root, "file-routes.d.ts"), "utf-8")).toContain(
      'path: "/custom/routes/index/from-to-route"'
    );
  });

  it("forwards components: false", async () => {
    const root = createRouteTree({ "index.tsx": "export default () => <h1>Home</h1>;" });
    await writeRouteTypes({ root, components: false });
    const declaration = fs.readFileSync(path.join(root, "file-routes.d.ts"), "utf-8");
    expect(declaration).toContain('path: "/"');
    expect(declaration).not.toContain("$component:");
  });

  it("reuses a supplied router's manifest and rescans without one", async () => {
    const root = createRouteTree({ "index.ts": "export default () => 'home';" });
    const router = new PageFileSystemRouter({
      dir: path.join(root, "src/routes"),
      extensions: ["ts"]
    });
    await router.getRoutes();
    expect(await writeRouteTypes({ root, router })).toBe(true);
    const file = path.join(root, "file-routes.d.ts");
    const declaration = fs.readFileSync(file, "utf-8");
    fs.utimesSync(file, new Date(0), new Date(0));
    const modified = fs.statSync(file).mtimeMs;

    fs.writeFileSync(path.join(root, "src/routes/about.ts"), "export default () => 'about';");
    expect(await writeRouteTypes({ root, router })).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe(declaration);
    expect(fs.statSync(file).mtimeMs).toBe(modified);

    expect(await writeRouteTypes({ root })).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toContain('path: "/about"');
  });

  it("leaves unchanged files untouched and rescans on the next call", async () => {
    const root = createRouteTree({ "index.ts": "export default () => 'home';" });
    const file = path.join(root, "file-routes.d.ts");
    expect(await writeRouteTypes({ root })).toBe(true);
    fs.utimesSync(file, new Date(0), new Date(0));
    const first = fs.statSync(file).mtimeMs;

    expect(await writeRouteTypes({ root })).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(first);

    fs.renameSync(path.join(root, "src/routes/index.ts"), path.join(root, "src/routes/about.ts"));
    expect(await writeRouteTypes({ root })).toBe(true);
    const declaration = fs.readFileSync(file, "utf-8");
    expect(declaration).toContain('path: "/about"');
    expect(declaration).not.toContain('path: "/"');
    expect(fs.statSync(file).mtimeMs).not.toBe(first);
  });

  it("writes empty tuples when no route modules are found", async () => {
    const root = createRouteTree({ "helper.ts": "export const helper = () => {};" });
    await writeRouteTypes({ root });
    const declaration = fs.readFileSync(path.join(root, "file-routes.d.ts"), "utf-8");
    expect(declaration).toContain("const routes: readonly [];");
    expect(declaration).toContain("export const pageRoutes: readonly [];");
  });

  it("rejects when the declaration cannot be written", async () => {
    const root = createRouteTree({ "index.ts": "export default () => 'home';" });
    await expect(
      writeRouteTypes({ root, file: "src/routes/index.ts/types.d.ts" })
    ).rejects.toThrow();
  });
});

describe("fileRoutes vite plugin", () => {
  it("serializes the manifest into a virtual module", async () => {
    const root = createRouteTree({
      "index.tsx": "export default () => <h1>Home</h1>;",
      "blog/[id].tsx": `
        export const route = { preload: () => {} };
        export default () => <h1>Post</h1>;
      `
    });

    const code = await loadVirtualModule(root);

    expect(code).toContain("export default routes;");
    // lazy refs become code-split dynamic imports picking component exports;
    // the id ends in a real extension so extension-filtered plugins match it
    expect(code).toMatch(/import\('[^']*index\.tsx\?pick=default&pick=\$css&lang\.tsx'\)/);
    // eager refs become static imports of the route config
    expect(code).toMatch(
      /import { route as routeData0 } from '[^']*\[id\]\.tsx\?pick=route&lang\.tsx';/
    );
    expect(code).toContain(`"path":"/blog/:id"`);
    expect(code).toContain(`'route': routeData0`);
  });

  it("serves a nested, group-stripped view alongside the flat manifest", async () => {
    const root = createRouteTree({
      "(app).tsx": "export default props => <main>{props.children}</main>;",
      "(app)/dashboard.tsx": "export default () => <h1>Dashboard</h1>;",
      "api/health.ts": "export const GET = () => new Response('ok');"
    });

    const code = await loadVirtualModule(root);

    // the layout keeps its group segment in the flat view...
    expect(code).toContain(`"path":"/(app)"`);
    // ...and loses it in the nested one, where the child is relative to it
    expect(code).toMatch(
      /export const pageRoutes = \[\{ \.\.\.route\d, id: "\/\(app\)", path: "\/", children: \[\{ \.\.\.route\d, id: "\/dashboard", path: "\/dashboard" \}\] \}\]/
    );
    // entries are referenced, not copied, so refs are emitted exactly once
    expect(code.match(/pick=default&pick=\$css&lang\.tsx'\)/g)?.length).toBe(2);
  });

  it("serializes lazy-ref src values with forward slashes", async () => {
    const directory = createRouteTree({
      "index.tsx": "export default () => <h1>Home</h1>;"
    });

    const split = await loadVirtualModule(directory);
    const eager = await loadWith(createPlugin(directory, { codeSplitting: false }), directory);

    // `src` is matched against Vite's manifest keys, which are always posix,
    // so it must not carry the platform separator node:path emits on Windows
    const src = '"src":"src/routes/index.tsx?pick=default&pick=$css&lang.tsx"';
    expect(split).toContain(src);
    expect(eager).toContain(src);
  });

  it("resolves only the virtual module id", async () => {
    const [plugin] = fileRoutes() as any[];
    expect(moduleId).toBe("virtual:file-routes");
    expect(plugin.resolveId(moduleId)).toBe(moduleId);
    expect(plugin.resolveId("./other")).toBeUndefined();
  });

  it("serves the manifest from a custom module id", async () => {
    const [plugin] = fileRoutes({ moduleId: "virtual:routes" }) as any[];
    expect(plugin.resolveId("virtual:routes")).toBe("virtual:routes");
    expect(plugin.resolveId(moduleId)).toBeUndefined();
  });

  it("excludes packages importing the virtual module from prebundling on request", () => {
    // adapters take the manifest as an argument, so nothing is excluded by default
    const [defaults] = fileRoutes() as any[];
    expect(defaults.config().optimizeDeps).toBeUndefined();

    const [custom] = fileRoutes({ optimizeDepsExclude: ["some-adapter"] }) as any[];
    expect(custom.config().optimizeDeps.exclude).toEqual(["some-adapter"]);
  });

  it("names route chunks after their file, not their pick id", () => {
    const [plugin] = fileRoutes() as any[];
    const sanitize = plugin.config().build.rollupOptions.output.sanitizeFileName;

    expect(sanitize("index.tsx?pick=default&pick=$css&lang")).toBe("index");
  });

  describe("types", () => {
    it("uses the client router for declarations with per-environment routers", async () => {
      const root = createRouteTree({ "index.ts": "export default () => 'home';" });
      const router = (routePath: string) =>
        new PageFileSystemRouter({
          dir: path.join(root, "src/routes"),
          extensions: ["ts"],
          toPath: () => routePath
        });
      const plugin = createPlugin(root, {
        types: true,
        router: router("/default"),
        routers: { client: router("/client"), ssr: router("/server") }
      });
      await plugin.buildStart.call({});
      const declaration = fs.readFileSync(path.join(root, "file-routes.d.ts"), "utf-8");
      expect(declaration).toContain('path: "/client"');
      expect(declaration).not.toContain('path: "/default"');
      expect(declaration).not.toContain('path: "/server"');
    });

    it("declares the manifest as a literal tuple", async () => {
      const root = createRouteTree({
        "(app).tsx": "export default props => <main>{props.children}</main>;",
        "(app)/blog/[id].tsx": `
          export const route = { preload: () => {} };
          export default () => <h1>Post</h1>;
        `,
        "api/health.ts": "export const GET = () => new Response('ok');"
      });
      const plugin = createPlugin(root, { types: "generated.d.ts", httpMethods: true });

      await plugin.buildStart.call({});
      const declaration = fs.readFileSync(path.join(root, "generated.d.ts"), "utf-8");

      expect(declaration).toContain('declare module "virtual:file-routes"');
      // a tuple, not an array — path-derived types degrade to `any` on arrays
      expect(declaration).toMatch(/const routes: readonly \[/);
      expect(declaration).toMatch(/export const pageRoutes: readonly \[/);
      // literal paths, nested exactly as the runtime view nests them
      expect(declaration).toContain('path: "/(app)"');
      expect(declaration).toContain('path: "/blog/:id"');
      expect(declaration).toMatch(/children: readonly \[[\s\S]*path: "\/blog\/:id"/);
      // absent refs stay readable rather than vanishing from the type
      expect(declaration).toContain("$$route?: undefined");
      // refs are typed by the module they point at, so an adapter reads a
      // page's real default export and a route module's real config
      expect(declaration).toMatch(
        /\$component: FileRouteLazyRef<typeof import\("\.\/src\/routes\/\(app\)\/blog\/\[id\]"\)>/
      );
      expect(declaration).toMatch(/\$\$route: FileRouteEagerRef<typeof import\(/);
      // handler refs are typed too, and a handler-only module is not a page
      expect(declaration).toMatch(/\$GET: FileRouteLazyRef<typeof import\(/);
      expect(declaration).toMatch(/path: "\/api\/health";\s*\n\s*page: false/);
    });

    it("falls back to a generic ref for modules TypeScript cannot resolve", async () => {
      const root = createRouteTree({
        "index.tsx": "export default () => <h1>Home</h1>;",
        "post.md": "# Post"
      });
      const plugin = createPlugin(root, {
        types: "generated.d.ts",
        extensions: ["tsx", "md"]
      });

      await plugin.buildStart.call({});
      const declaration = fs.readFileSync(path.join(root, "generated.d.ts"), "utf-8");

      expect(declaration).toMatch(/path: "\/post";[\s\S]*?\$component: FileRouteLazyRef;/);
      expect(declaration).toMatch(
        /\$component: FileRouteLazyRef<typeof import\("\.\/src\/routes\/index"\)>/
      );
    });

    it("rewrites the declaration only when the routes change", async () => {
      const root = createRouteTree({ "index.tsx": "export default () => <h1>Home</h1>;" });
      const plugin = createPlugin(root, { types: "generated.d.ts" });

      await plugin.buildStart.call({});
      const first = fs.statSync(path.join(root, "generated.d.ts")).mtimeMs;

      await plugin.buildStart.call({});
      expect(fs.statSync(path.join(root, "generated.d.ts")).mtimeMs).toBe(first);
    });

    it("writes nothing unless asked", async () => {
      const root = createRouteTree({ "index.tsx": "export default () => <h1>Home</h1>;" });
      const plugin = createPlugin(root);

      await plugin.buildStart.call({});

      expect(fs.existsSync(path.join(root, "file-routes.d.ts"))).toBe(false);
    });
  });

  describe("handler refs per environment", () => {
    // One shared router with httpMethods on — the fullstack SSR shape:
    // an API-only module, and a page that also exports a handler.
    const root = () =>
      createRouteTree({
        "index.tsx": "export default () => <h1>Home</h1>;",
        "users.tsx": `
          export const GET = () => new Response("users");
          export default () => <h1>Users</h1>;
        `,
        "api/users.ts": "export const POST = () => new Response('created');"
      });

    it("serves handler refs to server-consumer environments", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { httpMethods: true });

      const code = await loadWith(plugin, directory, "ssr");

      expect(code).toContain('"$POST"');
      expect(code).toMatch(/import\('[^']*api\/users\.ts\?pick=POST&lang\.ts'\)/);
      // a lone GET answers HEAD too
      expect(code).toContain('"$HEAD"');
    });

    it("strips handler refs from client-consumer manifests", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { httpMethods: true });

      const code = await loadWith(plugin, directory, "client");

      // no handler refs, and the handler-only API entry is gone entirely —
      // neither its module nor its path reaches the client bundle
      expect(code).not.toContain("$GET");
      expect(code).not.toContain("$POST");
      expect(code).not.toContain("api/users.ts");
      expect(code).not.toContain("/api/users");
      // the page half of a page+handler module stays routable
      expect(code).toMatch(/import\('[^']*users\.tsx\?pick=default&pick=\$css&lang\.tsx'\)/);
      expect(code).toContain('"path":"/users"');
    });

    it("splits by consumer, not by name, when the environment declares one", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { httpMethods: true });

      // an SSR environment under a custom name (workerd, nitro, ...)
      const custom = await loadWith(plugin, directory, "workerd", "server");
      expect(custom).toContain('"$POST"');

      // and a client consumer under a custom name still gets the strip
      const preview = await loadWith(plugin, directory, "browser-preview", "client");
      expect(preview).not.toContain("$POST");
    });

    it("serves an explicit per-environment router untouched", async () => {
      const directory = root();
      const routerDir = path.join(directory, "src", "routes");
      const explicit = new PageFileSystemRouter({
        dir: routerDir.replaceAll("\\", "/"),
        extensions: ["ts", "tsx"],
        httpMethods: true
      });
      const [plugin] = fileRoutes({ routers: { client: explicit } }) as any[];
      plugin.configResolved({ root: directory });

      // the app asked for handlers in its client manifest by name — explicit
      // per-environment routers are the escape hatch, not a leak
      const code = await loadWith(plugin, directory, "client");
      expect(code).toContain('"$POST"');
    });

    it("keeps handler modules out of client build inputs", async () => {
      const directory = root();
      const plugin = createPlugin(directory, {
        httpMethods: true,
        buildInputs: ["client", "ssr"]
      });

      const client = await plugin.configEnvironment("client", {}, { command: "build" });
      const clientInput: string[] = client.build.rollupOptions.input;
      expect(clientInput.some(id => id.includes("pick=POST"))).toBe(false);
      expect(clientInput.some(id => id.includes("pick=default"))).toBe(true);

      const ssr = await plugin.configEnvironment("ssr", {}, { command: "build" });
      const ssrInput: string[] = ssr.build.rollupOptions.input;
      expect(ssrInput.some(id => id.includes("pick=POST"))).toBe(true);
    });
  });

  describe("codeSplitting: false", () => {
    const root = () =>
      createRouteTree({
        "index.tsx": "export default () => <h1>Home</h1>;",
        "blog/[id].tsx": `
          export const route = { preload: () => {} };
          export default () => <h1>Post</h1>;
        `,
        "api/users.ts": "export const POST = () => new Response('created');"
      });

    it("delivers lazy refs eagerly: static namespace imports, require-shaped refs", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { codeSplitting: false });

      const code = await loadWith(plugin, directory);

      // zero dynamic imports anywhere in the module
      expect(code).not.toContain("import(");
      // component refs are statically imported behind the eager `require`
      // shape — a namespace import, since the synthetic `$css` pick is not
      // a real export — and keep the `src` lazy refs expose
      expect(code).toMatch(
        /import \* as routeModule\d from '[^']*index\.tsx\?pick=default&pick=\$css&lang\.tsx';/
      );
      expect(code).toMatch(/"\$component":\{"src":"[^"]+","require":\(\) => \(routeModule\d\)\}/);
      // `$$` refs were already eager and are unchanged
      expect(code).toMatch(
        /import { route as routeData\d } from '[^']*\[id\]\.tsx\?pick=route&lang\.tsx';/
      );
    });

    it("delivers handler refs eagerly to server environments too", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { codeSplitting: false, httpMethods: true });

      const code = await loadWith(plugin, directory, "ssr");

      expect(code).toContain('"$POST"');
      expect(code).not.toContain("import(");
      expect(code).toMatch(
        /import \* as routeModule\d from '[^']*api\/users\.ts\?pick=POST&lang\.ts';/
      );
    });

    it("contributes no build inputs — nothing is code-split", async () => {
      const plugin = createPlugin(root(), { codeSplitting: false, buildInputs: "client" });

      expect(await plugin.configEnvironment("client", {}, { command: "build" })).toBeUndefined();
    });

    it("types lazy refs as delivered: eager", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { codeSplitting: false, types: "generated.d.ts" });

      await plugin.buildStart.call({});
      const declaration = fs.readFileSync(path.join(directory, "generated.d.ts"), "utf-8");

      expect(declaration).toMatch(
        /\$component: FileRouteEagerRef<typeof import\("\.\/src\/routes\/index"\)>/
      );
      // no delivered ref is typed lazy (the interface itself stays declared)
      expect(declaration).not.toMatch(/\$\w+: FileRouteLazyRef/);
    });
  });

  describe("serverComponents", () => {
    const root = () =>
      createRouteTree({
        "index.tsx": "export default () => <h1>Home</h1>;",
        "stories/[id].tsx": `
          export const route = { live: true };
          export default async function Story({ params }) { "use server"; return () => null; }
        `
      });

    it("delivers a server page eagerly and flags it, leaving client pages split", async () => {
      const directory = root();
      const code = await loadWith(createPlugin(directory, { serverComponents: true }), directory);

      expect(code).toMatch(
        /import \* as routeModule\d from '[^']*\[id\]\.tsx\?pick=default&lang\.tsx';/
      );
      expect(code).toMatch(
        /"server":true,"\$component":\{"src":"[^"]+","require":\(\) => \(routeModule\d\)\}/
      );
      // the client page is still a code-split dynamic import
      expect(code).toMatch(/import\('[^']*index\.tsx\?pick=default&pick=\$css&lang\.tsx'\)/);
    });

    it("is not a build input — the stub is inlined into the manifest", async () => {
      const plugin = createPlugin(root(), { serverComponents: true, buildInputs: "client" });
      const input: string[] = (await plugin.configEnvironment("client", {}, { command: "build" }))
        .build.rollupOptions.input;
      expect(input).toHaveLength(1);
      expect(input[0]).toContain("index.tsx");
    });

    it("types the server page as delivered: eager, with `server: true`", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { serverComponents: true, types: "generated.d.ts" });
      await plugin.buildStart.call({});
      const declaration = fs.readFileSync(path.join(directory, "generated.d.ts"), "utf-8");
      expect(declaration).toMatch(
        /server: true;\s*\n\s*\$component: FileRouteEagerRef<typeof import\("\.\/src\/routes\/stories\/\[id\]"\)>/
      );
      expect(declaration).toMatch(
        /\$component: FileRouteLazyRef<typeof import\("\.\/src\/routes\/index"\)>/
      );
    });

    it("serves scan facts from `filesystem-routing/flags`: folded in build, true in serve", async () => {
      const directory = root();
      const load = (plugin: any, mode: string) =>
        plugin.load.call(
          { environment: { config: { root: directory }, mode, name: "client" } },
          plugin.resolveId("filesystem-routing/flags")
        );

      const on = createPlugin(directory, { serverComponents: true });
      expect(await load(on, "build")).toBe("export const serverRoutes = true;");
      // the option off: no route is a server page, so the fact folds to false
      const off = createPlugin(directory);
      expect(await load(off, "build")).toBe("export const serverRoutes = false;");
      // serve never folds: dev has no size to protect
      expect(await load(off, "dev")).toBe("export const serverRoutes = true;");
      // an unrelated id is not claimed
      expect(off.resolveId("filesystem-routing/other")).toBeUndefined();
    });
  });

  describe("buildInputs", () => {
    const root = () =>
      createRouteTree({
        "index.tsx": "export default () => <h1>Home</h1>;",
        "blog/[id].tsx": `
          export const route = { preload: () => {} };
          export default () => <h1>Post</h1>;
        `
      });

    it("takes every code-split route module as a build entry", async () => {
      const plugin = createPlugin(root(), { buildInputs: "client" });

      const config = await plugin.configEnvironment("client", {}, { command: "build" });
      const input: string[] = config.build.rollupOptions.input;

      expect(input).toHaveLength(2);
      expect(input.every(id => id.includes("?pick=default&pick=$css"))).toBe(true);
      // ids end in a real extension so extension-filtered plugins match them
      expect(input.every(id => id.endsWith("&lang.tsx"))).toBe(true);
      // `$$route` refs are inlined into the manifest, so they are not entries
      expect(input.some(id => id.includes("?pick=route"))).toBe(false);
    });

    it("only contributes inputs to the named environments, on build", async () => {
      const directory = root();
      const plugin = createPlugin(directory, { buildInputs: "client" });

      expect(await plugin.configEnvironment("ssr", {}, { command: "build" })).toBeUndefined();
      expect(await plugin.configEnvironment("client", {}, { command: "serve" })).toBeUndefined();

      const off = createPlugin(directory);
      expect(await off.configEnvironment("client", {}, { command: "build" })).toBeUndefined();
    });
  });
});
