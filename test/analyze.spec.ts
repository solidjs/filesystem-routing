import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { analyzeModule } from "../src/analyze.ts";
import { PageFileSystemRouter } from "../src/convention.ts";

const temporaryDirectories: string[] = [];

function writeRoute(source: string, name = "route.tsx") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "file-routes-"));
  const filename = path.join(directory, name);
  temporaryDirectories.push(directory);
  fs.writeFileSync(filename, source);
  return filename;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});

describe("analyzeModule", () => {
  it("returns runtime exports from TSX modules", () => {
    const route = writeRoute(`
      export type TypeOnly = string;
      const local = 1;
      export { local, local as renamed };
      export const route = {};
      export function GET() {}
      export default function Route() {
        return <main />;
      }
    `);

    const exports = analyzeModule(route);

    expect(
      exports.map(entry => entry.exportName.name ?? entry.exportName.kind.toLowerCase())
    ).toEqual(["local", "renamed", "route", "GET", "default"]);
    expect(exports.every(entry => !entry.isType)).toBe(true);
  });

  it("preserves local-name semantics for re-exports", () => {
    const route = writeRoute(`
      export { external, external as renamedExternal } from "./external.ts";
      export { default as DefaultExport } from "./external.ts";
      export * as namespace from "./external.ts";
      export * from "./external.ts";
    `);

    const exports = analyzeModule(route);

    expect(exports.map(entry => entry.exportName.name)).toEqual([
      "external",
      "renamedExternal",
      "DefaultExport",
      "namespace"
    ]);
    expect(exports.map(entry => entry.importName.name)).toEqual([
      "external",
      "external",
      "default",
      null
    ]);
  });

  it("throws on invalid route syntax", () => {
    const route = writeRoute("export default function Route( {");

    expect(() => analyzeModule(route)).toThrow(`Failed to parse ${route}`);
  });

  it("does not include an anonymous default export twice", () => {
    const route = writeRoute("export default () => <main />;");
    const router = new PageFileSystemRouter({
      dir: path.dirname(route),
      extensions: ["tsx"]
    });

    expect(router.toRoute(route)?.$component?.pick).toEqual(["default", "$css"]);
  });

  it("returns runtime exports from TSRX modules", () => {
    const route = writeRoute(
      `
      export type TypeOnly = string;
      export const route = {
        preload: () => {}
      };
      export function GET() {}
      export default function Route(props: { title?: string }) @{
        const label = props.title ?? "TSRX";
        <main>
          <style>
            .hero { color: rgb(0, 0, 0); }
          </style>
          @if (label.length > 0) {
            <h1 class="hero">{label}</h1>
          }
        </main>
      }
    `,
      "route.tsrx"
    );

    const exports = analyzeModule(route);

    expect(
      exports.map(entry => entry.exportName.name ?? entry.exportName.kind.toLowerCase())
    ).toEqual(["route", "GET", "default"]);
    expect(exports.every(entry => !entry.isType)).toBe(true);
  });

  it("applies the page convention to TSRX modules", () => {
    const route = writeRoute(
      `
      export const route = { preload: () => {} };
      export default function Route() @{
        <main />
      }
    `,
      "route.tsrx"
    );
    const router = new PageFileSystemRouter({
      dir: path.dirname(route),
      extensions: ["tsx", "tsrx"]
    });

    const entry = router.toRoute(route);
    expect(entry?.page).toBe(true);
    expect(entry?.$component?.pick).toEqual(["default", "$css"]);
    expect(entry?.$$route?.pick).toEqual(["route"]);
  });

  it("throws on invalid TSRX route syntax", () => {
    const route = writeRoute("export default function Route() @{", "route.tsrx");

    expect(() => analyzeModule(route)).toThrow(`Failed to parse ${route}`);
  });
});
