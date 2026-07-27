# filesystem-routing

Router-neutral file-system routing.

This package owns the *machinery* of file routing — scanning a directory,
applying a filename convention and producing a neutral **route manifest** —
while routers own the *shapes*: each router ships a small emission adapter
that turns the manifest into its own route definitions, and each bundler ships
a delivery adapter that materializes the manifest into code.

| Piece | Owner |
| --- | --- |
| Scanning, filename convention, neutral route manifest | `filesystem-routing` |
| Nesting + `(group)` stripping | `filesystem-routing/tree` |
| Vite delivery (virtual module, HMR, code splitting, build inputs) | `filesystem-routing/vite` |
| `RouteDefinition` emission | `@solidjs/router/fs` |
| Request handling for `GET`/`POST` routes, middleware | `@solidjs/start` |

Nothing here is Solid-specific: the core is bundler-agnostic — it never imports
Vite — the Vite adapter is router-agnostic, and the conventions are the ones
proven by SolidStart. The manifest is served from `virtual:file-routes`, or
from whatever id you pass as `fileRoutes({ moduleId })`.

## Usage with Solid Router and Vite

```ts
// vite.config.ts
import { fileRoutes } from "filesystem-routing/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  // `extensions` makes vite-plugin-solid also compile the `?pick=` route
  // modules this plugin emits (their ids end in a query string)
  plugins: [solid({ extensions: [".jsx", ".tsx"] }), fileRoutes()]
});
```

```tsx
// src/app.tsx
import { pageRoutes } from "virtual:file-routes";
import { createRouter } from "@solidjs/router";
import { fileRoutes } from "@solidjs/router/fs";

const Router = createRouter({ routes: fileRoutes(pageRoutes) });

export const App = () => <Router>{props => <>{props.children}</>}</Router>;
```

The emission adapter never imports the virtual module itself — the app does,
so the adapter resolves without the plugin, custom `moduleId`s work, and
nothing needs excluding from dependency prebundling.

Route modules live in `src/routes` (configurable via `fileRoutes({ dir })`).
A module is a page when it has a default export, and may export a `route`
config object:

```tsx
// src/routes/blog/[id].tsx
import type { RouteDefinition } from "@solidjs/router";

export const route = {
  preload: ({ params }) => loadPost(params.id)
} satisfies RouteDefinition;

export default function Post() {
  return <h1>Post</h1>;
}
```

## Filename conventions

Two conventions ship in the box. Both produce the same neutral manifest and
share the same module convention (default export is a page, `route` config
export, `httpMethods` handlers), so they are equally capable — only the
filenames differ.

### Nested (`PageFileSystemRouter`, the default)

The convention proven by SolidStart:

| File | Path |
| --- | --- |
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `blog/[id].tsx` | `/blog/:id` |
| `blog/[[page]].tsx` | `/blog/:page?` |
| `docs/[...path].tsx` | `/docs/*path` |
| `(marketing)/about.tsx` | `/about`, nested in the `(marketing)` group |

Nested layouts come from pairing a file with a directory: `blog.tsx` is the
layout for everything in `blog/`.

### Flat (`FlatFileSystemRouter`)

The convention proven by Remix v2 and carried forward by React Router's
`@react-router/fs-routes` — `.` delimiters instead of directories:

| File | Path |
| --- | --- |
| `_index.tsx` | `/` |
| `about.tsx` | `/about` |
| `concerts.trending.tsx` | `/concerts/trending` |
| `concerts.$city.tsx` | `/concerts/:city` |
| `concerts.($page).tsx` | `/concerts/:page?` |
| `files.$.tsx` | `/files/*splat` |
| `_auth.login.tsx` | `/login`, nested in the `_auth.tsx` pathless layout |
| `concerts_.mine.tsx` | `/concerts/mine`, escaping the `concerts.tsx` layout |
| `[sitemap.xml].tsx` | `/sitemap.xml` — brackets escape special characters |

`concerts.tsx` is the layout for every `concerts.*` file; a top-level folder
routes through its `route.tsx` module and co-locates everything else in the
folder without routing it. Pass the router to the plugin:

```ts
import { FlatFileSystemRouter } from "filesystem-routing";
import { fileRoutes } from "filesystem-routing/vite";
import { resolve } from "node:path";

fileRoutes({
  router: new FlatFileSystemRouter({
    dir: resolve("src/routes"),
    extensions: ["js", "jsx", "ts", "tsx"]
  })
});
```

Two departures from Remix: the catch-all param is named (`params.splat`
rather than `params["*"]`), and optional *static* segments (`(en).about.tsx`)
are rejected — the neutral pattern language has no representation for them.

## API routes

Route modules can answer requests as well as render. Turn on `httpMethods`
(off by default — a client-only manifest has no use for handlers) and
uppercase exports become request handlers:

```ts
// src/routes/api/posts/[id].ts
export function GET(event) {
  return Response.json(loadPost(event.params.id));
}

export function DELETE(event) {
  deletePost(event.params.id);
  return new Response(null, { status: 204 });
}
```

The scanner turns each handler export into a lazy ref on the entry —
`$GET: { src, pick: ["GET"] }`, `$DELETE: …` — with the same code splitting
pages get:

- A module with handlers but no default export routes without being a page:
  `{ path: "/api/posts/:id", page: false, $GET, $DELETE }`.
- A module can be both. A page with a `GET` export gets `$component` *and*
  `$GET`, and handler exports are excluded from the component ref's picks, so
  handler code never reaches the client bundle.
- A lone `GET` also answers `HEAD`: a `$HEAD` ref aliasing the `GET` export
  is added unless the module exports its own.
- The recognized set is `HEAD`/`GET`/`POST`/`PUT`/`DELETE`/`PATCH`/`OPTIONS`;
  pass an array instead of `true` to change it.

This package stops at the manifest: it discovers handlers, it does not serve
them. Dispatch is a few lines in whatever server consumes the manifest —
match the URL, import the ref, call the export:

```ts
// any SSR handler or middleware
import routes from "virtual:file-routes";

async function handleApi(request: Request, entry, params) {
  const ref = entry[`$${request.method}`];
  if (!ref) return new Response(null, { status: 405 });
  const handlers = await ref.import();
  // a HEAD alias imports the GET handler
  return (handlers[request.method] ?? handlers.GET)({ request, params });
}
```

The handler's argument is whatever your server passes — the convention only
dictates the export names. Frameworks typically enable `httpMethods` on the
server environment's router only (SolidStart pairs it with `components:
false` in SPA mode, so the server manifest routes requests without shipping
page modules) — see the per-environment `routers` option below.

## Custom conventions

Conventions plug in at two independent seams, so a custom scheme picks the
level it needs:

- **`toPath`** — the filename convention: maps a route file (relative to
  `dir`, extension stripped, e.g. `/blog/[id]`) to a route path in the
  neutral pattern language (`:param`, `:param?`, `*rest`, `(group)`), or
  `undefined` to skip the file. Layout nesting is encoded in the paths
  themselves: `buildRouteTree` nests entries by path prefix (a layout at
  `/blog` wraps a page at `/blog/`), and `(group)` segments nest without
  contributing URL — which is also how pathless layouts and layout escapes
  are expressed.
- **`toRoute`** — the module convention: maps a source file to a manifest
  entry, deciding what makes a file a route and which refs it carries. The
  built-in one analyzes exports (default export, `route` config, HTTP
  handlers); a custom one can key off anything.

Pass either as config for one-off tweaks:

```ts
import { PageFileSystemRouter } from "filesystem-routing";
import { fileRoutes } from "filesystem-routing/vite";

fileRoutes({
  toPath: routeFile => (routeFile.endsWith(".page") ? routeFile.slice(0, -5) : undefined)
});
```

Or subclass for a full scheme — `FlatFileSystemRouter` is the model: it
extends `PageFileSystemRouter`, overrides only `toPath`, and everything else
(scanning, watching, module analysis, the tree, type generation) is
inherited. A convention that also changes what a route module *is* overrides
`toRoute`; a convention that changes what gets scanned overrides `glob()` on
`BaseFileSystemRouter`.

## The manifest seam

The scanner produces flat `RouteManifestEntry` objects:

```ts
{
  path: "/blog/:id",           // neutral pattern language
  page: true,
  $component: { src, pick },   // lazy module ref → code-split dynamic import
  $$route: { src, pick }       // eager module ref → static import
}
```

The Vite adapter serializes the manifest into the virtual module, turning
`$`-prefixed refs into dynamic imports and `$$`-prefixed refs into static
imports, each tree-shaken down to the picked exports. It serves two views of
the same entries:

```ts
import routes, { pageRoutes } from "virtual:file-routes";
```

`routes` is the flat manifest; `pageRoutes` is the page entries nested by path
with `(group)` segments stripped, so emission adapters don't each reimplement
the tree (`buildRouteTree` from `filesystem-routing/tree` is the same
function, for consumers holding only a flat manifest). An emission adapter is
a function taking manifest entries and returning the router's shape — see
`fileRoutes` in `@solidjs/router/fs` for Solid Router's, a ~30 line adapter
other routers can mirror. Adapters take the manifest as an argument rather
than importing the virtual module, so they work standalone and with custom
module ids.

Add `/// <reference types="filesystem-routing/types" />` to type the import.

### Keeping path-derived types alive

A manifest is a runtime value, so a router that derives types from its route
table gets nothing from it — `@solidjs/router`'s `RoutePaths` degrades to `any`
the moment the table is a `RouteDefinition[]` rather than a tuple. Turn on
`types` and the plugin writes a declaration in which the manifest *is* a
literal tuple, regenerating it as routes come and go:

```ts
fileRoutes({ types: "file-routes.d.ts" })
```

Reference the generated file instead of `filesystem-routing/types` — it is
self-contained, and two declarations of the same module conflict. Emission
adapters then have to preserve the tuple on the way through, which means a
mapping typed over its input rather than a plain `.map`:

```ts
declare function toRoutes<const T extends readonly Entry[]>(
  entries: T
): { [K in keyof T]: RouteFrom<T[K]> };
```

Frameworks with several Vite environments can serve a different router (and
convention) per environment, and have the plugin take every route module as a
build entry for the browser one:

```ts
fileRoutes({
  routers: {
    // the browser routes and renders
    client: new PageFileSystemRouter({ dir, extensions }),
    // the server also answers `GET`/`POST` exports, and in SPA mode routes
    // without shipping components
    ssr: new PageFileSystemRouter({ dir, extensions, httpMethods: true, components: ssr })
  },
  buildInputs: "client"
});
```

| Option | What it does |
| --- | --- |
| `httpMethods` | emit `$GET`, `$POST`, … refs for uppercase handler exports; a module with handlers but no default export routes without being a page |
| `components` | set `false` to route without emitting `$component` refs, keeping page modules out of that environment's bundle |
| `buildInputs` | environments whose build takes every code-split route module as an entry |
| `moduleId` | the id the manifest is served from |
| `optimizeDepsExclude` | escape hatch for packages that import the virtual module, kept out of dep prebundling (defaults to `[]`) |
| `types` | write a declaration typing the manifest as a literal tuple, kept in step with the route directory |

## Credits

The design comes from [Vinxi](https://github.com/nksaraf/vinxi)'s file-system
router by Nikhil Saraf, which powered SolidStart through 1.x: the
`BaseFileSystemRouter` with pluggable `toPath`/`toRoute`, and above all the
insight that the manifest should carry inert module refs — `$`-prefixed keys
becoming dynamic imports, `$$`-prefixed keys becoming static ones — so any
router and any bundler can meet at the same seam. This package extracts that
approach into a standalone library, adding the nested tree view, the flat
convention, and literal-tuple type generation. The filename conventions are
the ones proven by [SolidStart](https://github.com/solidjs/solid-start) and
[Remix](https://remix.run) v2.
