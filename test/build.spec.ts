import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, type Rollup } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { fileRoutes, type FileRoutesOptions } from "../src/vite/index.ts";

// The delivery modes against a real Vite build: the same fixture bundled
// with code splitting on (the default) and off, pinning what actually
// reaches the output — chunks and dynamic imports in one mode, a single
// bundle with zero dynamic imports in the other. The virtual-module
// serialization itself is pinned by vite.spec.ts.

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});

function createApp() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-routes-build-")));
  temporaryDirectories.push(directory);
  const files: Record<string, string> = {
    "src/entry.ts": `
      import routes, { pageRoutes } from "virtual:file-routes";
      console.log(routes, pageRoutes);
    `,
    "src/routes/index.ts": `export default () => "home-marker";`,
    "src/routes/about.ts": `
      export const route = { info: { tag: "about-config" } };
      export default () => "about-marker";
    `
  };
  for (const [file, source] of Object.entries(files)) {
    const filename = path.join(directory, file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  return directory;
}

async function buildApp(root: string, options: FileRoutesOptions = {}) {
  const result = (await build({
    root,
    logLevel: "silent",
    plugins: [fileRoutes(options)],
    build: {
      write: false,
      minify: false,
      target: "esnext",
      rollupOptions: { input: path.join(root, "src/entry.ts") }
    }
  })) as Rollup.RollupOutput;
  return result.output.filter((item): item is Rollup.OutputChunk => item.type === "chunk");
}

describe("built fixture", () => {
  it("code-splits route modules behind dynamic imports by default", async () => {
    const chunks = await buildApp(createApp());

    // route modules land in chunks of their own, behind dynamic imports
    expect(chunks.length).toBeGreaterThan(1);
    const entry = chunks.find(chunk => chunk.isEntry)!;
    expect(entry.code).toContain("import(");
    expect(entry.code).not.toContain("home-marker");
    expect(entry.code).not.toContain("about-marker");
    const routeCode = chunks.filter(chunk => !chunk.isEntry).map(chunk => chunk.code);
    expect(routeCode.some(code => code.includes("home-marker"))).toBe(true);
    expect(routeCode.some(code => code.includes("about-marker"))).toBe(true);
    // the eager `route` config still rides in the entry
    expect(entry.code).toContain("about-config");
  });

  it("bundles everything into one chunk with zero dynamic imports when off", async () => {
    const chunks = await buildApp(createApp(), { codeSplitting: false });

    expect(chunks).toHaveLength(1);
    const [bundle] = chunks;
    expect(bundle.code).not.toContain("import(");
    expect(bundle.code).toContain("home-marker");
    expect(bundle.code).toContain("about-marker");
    expect(bundle.code).toContain("about-config");
  });
});
