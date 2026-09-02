import fs from "node:fs";
import { createRequire } from "node:module";
import { parseSync, type StaticExportEntry } from "oxc-parser";

export type { StaticExportEntry };

/**
 * `oxc-parser` cannot read TSRX syntax, so `.tsrx` route modules go through
 * the official TSRX oxc integration instead. `@tsrx/oxc/parser` mirrors the
 * `oxc-parser` API (same `ParseResult` shape, same static-export entries), so
 * the analysis below is parser-agnostic. The package is an optional peer:
 * it is loaded lazily, only when a `.tsrx` route module is actually scanned.
 */
type ParseFn = (
  filename: string,
  sourceText: string,
  options: { lang: string }
) => ReturnType<typeof parseSync>;

let tsrxParseSync: ParseFn | undefined;

function loadTsrxParser(src: string): ParseFn {
  if (!tsrxParseSync) {
    try {
      const facade = createRequire(import.meta.url)("@tsrx/oxc/parser") as {
        parseSync: ParseFn;
      };
      tsrxParseSync = facade.parseSync;
    } catch (cause) {
      throw new Error(
        `Cannot analyze the TSRX route module ${src}: analyzing .tsrx exports requires ` +
          `the optional peer dependency @tsrx/oxc. Install it (npm i -D @tsrx/oxc) ` +
          `or keep route modules in .ts/.tsx.`,
        { cause }
      );
    }
  }
  return tsrxParseSync;
}

/**
 * Analyze a route module's static exports.
 *
 * This is the compiler-shaped slice of file routing: it reports what a module
 * exports without knowing what a route is. It is kept behind its own seam so
 * a compiler that already performs export analysis can provide it instead.
 */
export function analyzeModule(src: string): StaticExportEntry[] {
  const source = fs.readFileSync(src, "utf-8");
  let result: ReturnType<typeof parseSync>;
  if (src.endsWith(".tsrx")) {
    const parse = loadTsrxParser(src);
    // The TSRX facade reports most syntax errors through `result.errors` but
    // throws on some malformed sources; normalize both into the same shape.
    try {
      result = parse(src, source, { lang: "tsrx" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SyntaxError(`Failed to parse ${src}:\n${message}`, { cause });
    }
  } else {
    result = parseSync(src, source, { lang: "tsx" });
  }
  const error = result.errors[0];
  if (error) throw new SyntaxError(`Failed to parse ${src}:\n${error.codeframe || error.message}`);

  return result.module.staticExports.flatMap(({ entries }) =>
    entries.filter(entry => !entry.isType && entry.exportName.kind !== "None")
  );
}

export function getExportName(entry: StaticExportEntry) {
  return entry.exportName.name ?? "default";
}

/**
 * Returns the export name only when it is backed by a same-named local
 * binding, i.e. it can be re-picked from the module without renaming.
 */
export function getLocalExportName(entry: StaticExportEntry) {
  const name = getExportName(entry);
  if (name === "default") return;
  return name === (entry.localName.name ?? entry.importName.name ?? name) ? name : undefined;
}
