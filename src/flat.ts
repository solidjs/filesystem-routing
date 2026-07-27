import { PageFileSystemRouter } from "./convention.ts";
import { cleanPath } from "./router.ts";

/**
 * The flat filename convention proven by Remix v2 and carried forward by
 * React Router's `@react-router/fs-routes` — `.` delimiters instead of
 * directories:
 * - `concerts.trending` maps to `/concerts/trending`
 * - `concerts._index` maps to the index under the `concerts` layout
 * - `$param` maps to `:param`, `($param)` to an optional `:param?`
 * - a lone `$` maps to the catch-all `*splat`
 * - `_prefixed` segments are pathless layouts, emitted as `(group)` segments
 * - `suffixed_` segments keep their URL but opt out of the parent layout
 * - `[brackets]` escape special characters: `[sitemap.xml]` is literal
 * - a top-level folder routes through its `route` module; sibling files are
 *   co-located, not routes
 *
 * Everything maps into the same neutral pattern language the nested
 * convention produces, so `buildRouteTree`, group stripping and emission
 * adapters work unchanged.
 */

interface FlatChar {
  char: string;
  escaped: boolean;
}

/** Splits a flat route name on unescaped `.`, resolving `[...]` escapes. */
function parseSegments(name: string): FlatChar[][] {
  const segments: FlatChar[][] = [[]];
  let inEscape = false;
  for (const char of name) {
    if (char === "[" && !inEscape) {
      inEscape = true;
    } else if (char === "]" && inEscape) {
      inEscape = false;
    } else if (char === "." && !inEscape) {
      segments.push([]);
    } else {
      segments[segments.length - 1].push({ char, escaped: inEscape });
    }
  }
  return segments;
}

interface FlatSegment {
  /** The segment in the neutral pattern language; `undefined` for `_index`. */
  text?: string;
  /** `true` when a trailing `_` opts the segment out of the parent layout. */
  escapesLayout: boolean;
}

const text = (chars: FlatChar[]) => chars.map(c => c.char).join("");
const unescapedAt = (chars: FlatChar[], index: number, char: string) =>
  chars.at(index)?.char === char && !chars.at(index)!.escaped;

function interpretSegment(segment: FlatChar[], isFinal: boolean): FlatSegment {
  // `_index` routes to its parent's path (the leading `_` must be literal)
  if (isFinal && unescapedAt(segment, 0, "_") && text(segment) === "_index") {
    return { escapesLayout: false };
  }

  let chars = segment;
  let escapesLayout = false;
  if (chars.length > 1 && unescapedAt(chars, -1, "_")) {
    chars = chars.slice(0, -1);
    escapesLayout = true;
  }

  // a pathless layout becomes a group segment the tree nests by and strips
  if (unescapedAt(chars, 0, "_")) {
    return { text: `(${text(chars)})`, escapesLayout };
  }

  let optional = false;
  if (chars.length > 2 && unescapedAt(chars, 0, "(") && unescapedAt(chars, -1, ")")) {
    chars = chars.slice(1, -1);
    optional = true;
  }

  if (unescapedAt(chars, 0, "$")) {
    const param = text(chars.slice(1));
    if (param === "") return { text: "*splat", escapesLayout };
    return { text: `:${param}${optional ? "?" : ""}`, escapesLayout };
  }

  if (optional) {
    throw new Error(`Optional static segments have no neutral representation: (${text(chars)})`);
  }

  return { text: text(chars), escapesLayout };
}

/**
 * Maps a flat route file (relative to the route dir, extension stripped,
 * e.g. `/concerts.$city`) to a route path in the neutral pattern language,
 * or `undefined` for co-located files that are not routes.
 */
export function flatRoutePathFromFile(routeFile: string): string | undefined {
  const parts = routeFile.slice(1).split("/");
  // a top-level folder routes through its `route` module only
  if (parts.length === 2 && parts[1] !== "route") return undefined;
  if (parts.length > 2) return undefined;

  const segments = parseSegments(parts[0]);
  const path: string[] = [];
  let index = false;

  for (const [i, segment] of segments.entries()) {
    const flat = interpretSegment(segment, i === segments.length - 1);
    if (flat.text === undefined) {
      index = true;
      break;
    }
    // a synthetic group breaks `buildRouteTree`'s prefix match with the
    // parent layout while stripping back out of the URL
    if (flat.escapesLayout) path.push(`(${flat.text}_)`);
    path.push(flat.text);
  }

  // an index route takes its parent's path plus a trailing slash, the same
  // shape the nested convention gives `index` files, so the tree nests it
  // under the layout that shares its path
  if (index) return `/${path.map(segment => segment + "/").join("")}`;
  return path.length > 0 ? `/${path.join("/")}` : "/";
}

/**
 * `PageFileSystemRouter` with the flat filename convention. The module
 * convention is inherited unchanged — default export is a page, `route`
 * config export, `httpMethods` handlers, `components: false` — so the two
 * conventions are equally capable; only the filenames differ.
 */
export class FlatFileSystemRouter extends PageFileSystemRouter {
  toPath(src: string): string | undefined {
    if (this.config.toPath) return super.toPath(src);
    return flatRoutePathFromFile(cleanPath(src, this.config));
  }
}
