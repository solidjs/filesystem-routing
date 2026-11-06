import { extname } from "node:path";
import type { Plugin } from "vite";
import { pickExports } from "./pick-exports.ts";

const PICKABLE_EXTENSIONS = ["js", "jsx", "ts", "tsx"];

/**
 * Builds the module id used to import a subset of a route file's exports.
 *
 * The `pick` list has to live in the query so that the same file can be
 * instantiated once per export subset (the client picks `default`/`$css`,
 * the server picks its HTTP handlers). That query would otherwise leave the
 * id ending in `?pick=GET`, which silently excludes route files from any
 * plugin whose filter is anchored on the file extension -- a very common
 * default, e.g. unplugin-macros' `/\.[cm]?[jt]sx?$/`.
 *
 * The trailing `lang.<ext>` marker is the same convention Vue SFCs use
 * (`?vue&type=script&lang.ts`) and puts a real extension back at the end of
 * the id, so those filters match again.
 *
 * @see https://github.com/solidjs/solid-start/issues/1918
 */
export function toPickId(src: string, pick: string[]): string {
  const query = pick.map(p => `pick=${p}`).join("&");
  const ext = extname(src).slice(1);
  return PICKABLE_EXTENSIONS.includes(ext) ? `${src}?${query}&lang.${ext}` : `${src}?${query}`;
}

/**
 * Matches the tail that {@link toPickId} appends, as it appears in a chunk
 * name. Bundlers derive a chunk name from the module id by taking the
 * basename minus its extension, so `index.tsx?pick=default&pick=$css&lang.tsx`
 * arrives here as `index.tsx?pick=default&pick=$css&lang`.
 */
const PICK_CHUNK_NAME_RE = /\.[cm]?[jt]sx?\?pick=[^?]*&lang$/;

const INVALID_CHAR_RE = /[\u0000-\u001F"#$&*+,:;<=>?[\]^`{|}\u007F]/g;
const DRIVE_LETTER_RE = /^[a-z]:/i;

/**
 * Rollup's default chunk name sanitizer, plus a pass that drops the
 * `?pick=...&lang` tail so route chunks keep the short, stable filenames they
 * had before the `lang` marker was introduced (`index-<hash>.js`, not
 * `index.tsx_pick_default_pick__css_lang-<hash>.js`). Client chunk filenames
 * are public URLs, so this is not purely cosmetic.
 *
 * @see https://github.com/rollup/rollup/blob/master/src/utils/sanitizeFileName.ts
 */
export function sanitizeChunkFileName(name: string): string {
  const stripped = name.replace(PICK_CHUNK_NAME_RE, "");
  const driveLetter = DRIVE_LETTER_RE.exec(stripped)?.[0] ?? "";
  return driveLetter + stripped.slice(driveLetter.length).replace(INVALID_CHAR_RE, "_");
}

export function treeShake(): Plugin {
  return {
    name: "filesystem-routing:tree-shake",
    enforce: "pre",
    transform(code, id) {
      const [path, queryString] = id.split("?");
      if (!path) return;
      const query = new URLSearchParams(queryString);
      if (query.has("pick") && PICKABLE_EXTENSIONS.includes(extname(path).slice(1))) {
        return pickExports(code, id, query.getAll("pick"));
      }
    }
  };
}
