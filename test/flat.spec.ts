import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRouteTree,
  FlatFileSystemRouter,
  flatRoutePathFromFile,
  routePathFromFile
} from "../src/index.ts";

describe("flatRoutePathFromFile", () => {
  it("maps dot delimiters to path segments", () => {
    expect(flatRoutePathFromFile("/about")).toBe("/about");
    expect(flatRoutePathFromFile("/concerts.trending")).toBe("/concerts/trending");
  });

  it("maps _index files to their parent's path", () => {
    expect(flatRoutePathFromFile("/_index")).toBe("/");
    expect(flatRoutePathFromFile("/concerts._index")).toBe("/concerts/");
  });

  it("maps $param segments to :param", () => {
    expect(flatRoutePathFromFile("/concerts.$city")).toBe("/concerts/:city");
    expect(flatRoutePathFromFile("/$lang.about")).toBe("/:lang/about");
  });

  it("maps ($param) segments to optional :param?", () => {
    expect(flatRoutePathFromFile("/($lang).categories")).toBe("/:lang?/categories");
  });

  it("maps a lone $ to the catch-all *splat", () => {
    expect(flatRoutePathFromFile("/$")).toBe("/*splat");
    expect(flatRoutePathFromFile("/files.$")).toBe("/files/*splat");
  });

  it("maps pathless _layouts to group segments", () => {
    expect(flatRoutePathFromFile("/_auth")).toBe("/(_auth)");
    expect(flatRoutePathFromFile("/_auth.login")).toBe("/(_auth)/login");
    expect(flatRoutePathFromFile("/_auth._index")).toBe("/(_auth)/");
  });

  it("opts trailing_ segments out of the parent layout via a synthetic group", () => {
    expect(flatRoutePathFromFile("/concerts_.mine")).toBe("/(concerts_)/concerts/mine");
    expect(flatRoutePathFromFile("/dashboard.projects_.new")).toBe(
      "/dashboard/(projects_)/projects/new"
    );
  });

  it("escapes special characters with brackets", () => {
    expect(flatRoutePathFromFile("/[sitemap.xml]")).toBe("/sitemap.xml");
    expect(flatRoutePathFromFile("/sitemap[.]xml")).toBe("/sitemap.xml");
    expect(flatRoutePathFromFile("/[_index]")).toBe("/_index");
    expect(flatRoutePathFromFile("/report.[$id]")).toBe("/report/$id");
  });

  it("routes a top-level folder through its route module only", () => {
    expect(flatRoutePathFromFile("/concerts.$city/route")).toBe("/concerts/:city");
    expect(flatRoutePathFromFile("/concerts.$city/CityList")).toBeUndefined();
    expect(flatRoutePathFromFile("/concerts.$city/nested/route")).toBeUndefined();
  });

  it("rejects optional static segments, which have no neutral representation", () => {
    expect(() => flatRoutePathFromFile("/(en).about")).toThrow(/Optional static/);
  });
});

describe("convention parity", () => {
  it("expresses every path the nested convention expresses", () => {
    const pairs: [nested: string, flat: string][] = [
      ["/index", "/_index"],
      ["/about", "/about"],
      ["/blog/index", "/blog._index"],
      ["/blog/[id]", "/blog.$id"],
      ["/blog/[[page]]", "/blog.($page)"],
      ["/(marketing)/about", "/_marketing.about"]
    ];
    for (const [nested, flat] of pairs) {
      const nestedPath = routePathFromFile(nested);
      const flatPath = flatRoutePathFromFile(flat);
      // groups differ in name but strip to the same URL
      const strip = (p: string) => p.replace(/\([^)/]+\)/g, "").replace(/\/+/g, "/");
      expect(strip(flatPath!)).toBe(strip(nestedPath!));
    }
    // catch-alls differ only in the param name: [...rest] names it, $ cannot
    expect(routePathFromFile("/docs/[...splat]")).toBe(flatRoutePathFromFile("/docs.$"));
  });
});

const temporaryDirectories: string[] = [];

function createRouteTree(files: Record<string, string>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-routes-flat-")));
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

describe("FlatFileSystemRouter", () => {
  it("scans a flat route directory into the neutral manifest", async () => {
    const dir = createRouteTree({
      "_index.tsx": "export default () => <h1>Home</h1>;",
      "about.tsx": "export default () => <h1>About</h1>;",
      "concerts.tsx": "export default props => <div>{props.children}</div>;",
      "concerts._index.tsx": "export default () => <h1>Concerts</h1>;",
      "concerts.$city.tsx": `
        export const route = { preload: () => {} };
        export default () => <h1>City</h1>;
      `,
      "concerts.$city/helper.ts": "export const helper = () => {};"
    });
    const router = new FlatFileSystemRouter({ dir, extensions: ["ts", "tsx"] });

    const routes = await router.getRoutes();
    const paths = routes.map(route => route.path).sort();

    expect(paths).toEqual(["/", "/about", "/concerts", "/concerts/", "/concerts/:city"]);

    // the module convention is inherited from PageFileSystemRouter
    const city = routes.find(route => route.path === "/concerts/:city")!;
    expect(city.page).toBe(true);
    expect(city.$component?.pick).toEqual(["default", "$css"]);
    expect(city.$$route?.pick).toEqual(["route"]);
  });

  it("nests layouts and escapes them through the standard tree", async () => {
    const dir = createRouteTree({
      "concerts.tsx": "export default props => <div>{props.children}</div>;",
      "concerts._index.tsx": "export default () => <h1>Concerts</h1>;",
      "concerts.trending.tsx": "export default () => <h1>Trending</h1>;",
      "concerts_.mine.tsx": "export default () => <h1>Mine</h1>;",
      "_auth.tsx": "export default props => <div>{props.children}</div>;",
      "_auth.login.tsx": "export default () => <h1>Login</h1>;"
    });
    const router = new FlatFileSystemRouter({ dir, extensions: ["tsx"] });
    const routes = await router.getRoutes();

    const tree = buildRouteTree(routes.filter(route => route.page));
    const summarize = (entries: typeof tree): unknown =>
      entries.map(entry => ({
        path: entry.path,
        children: entry.children ? summarize(entry.children) : undefined
      }));

    expect(summarize(tree)).toEqual([
      // the pathless layout wraps its children without a URL segment
      { path: "/", children: [{ path: "/login", children: undefined }] },
      {
        path: "/concerts",
        children: [
          { path: "/", children: undefined },
          { path: "/trending", children: undefined }
        ]
      },
      // trailing _ keeps the URL but stays out of the concerts layout
      { path: "/concerts/mine", children: undefined }
    ]);
  });

  it("picks up HTTP handler exports when http methods are on", async () => {
    const dir = createRouteTree({
      "api.health.ts": "export const GET = () => new Response('ok');"
    });
    const router = new FlatFileSystemRouter({
      dir,
      extensions: ["ts"],
      httpMethods: true
    });

    const routes = await router.getRoutes();

    const health = routes.find(route => route.path === "/api/health")!;
    expect(health.page).toBe(false);
    expect(health.$GET).toEqual({
      src: expect.stringContaining("api.health.ts"),
      pick: ["GET"]
    });
  });
});
