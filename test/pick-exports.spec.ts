import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { pickExports } from "../src/vite/pick-exports.ts";
import { babelPickExports } from "./support/babel-pick-exports.ts";

function normalize(code: string) {
  const { program, errors } = parseSync("output.tsx", code, { lang: "tsx", astType: "ts" });
  expect(errors).toEqual([]);
  const strip = (node: any): any => {
    if (Array.isArray(node)) return node.map(strip).filter(item => item?.type !== "EmptyStatement");
    if (!node || typeof node !== "object") return node;
    if (node.type === "ParenthesizedExpression") return strip(node.expression);
    const result: any = {};
    for (const key of Object.keys(node)) {
      if (key !== "start" && key !== "end" && key !== "raw") result[key] = strip(node[key]);
    }
    if (result.type === "ArrayPattern") {
      while (result.elements.at(-1) === null) result.elements.pop();
    }
    return result;
  };
  return strip(program.body);
}

const id = (ext: string, pick: string[]) =>
  `/routes/route.${ext}?${pick.map(name => `pick=${name}`).join("&")}&lang.${ext}`;

function pick(code: string, names: string[], ext = "tsx") {
  return pickExports(code, id(ext, names), names)?.code;
}

function babel(code: string, names: string[], ext = "tsx") {
  return babelPickExports(code, id(ext, names), names)?.code;
}

const JS_ROUTE = `
"use strict";
import { db, log as print } from "./db.js";
import defaults, { schema } from "./schema.js";
import * as helpers from "./helpers.js";
import unusedFromTheStart from "./side-effects.js";
import "./setup.js";
import "./styles.css";
import styles from "./module.module.css";

const cache = new Map();
let counter = 0;
var legacy = 1, other = legacy + 1;
const unusedWithSideEffect = print("stays");

export function loader() {
  return db.read(schema);
}
export async function* stream() {
  yield helpers.first();
}
export class Store {
  static value = cache;
  #secret = defaults;
  get secret() {
    return this.#secret;
  }
}
export const GET = async () => {
  counter++;
  return { cache, counter, label: styles.title };
};
export const POST = () => db.write(other);
export const first = print("first"), second = () => first, third = 3;
export const { destructured, nested: { deep } } = helpers.values();
export let reassigned = 1;
reassigned = 2;
export var assignedFunction;
assignedFunction = function () {
  return db;
};
function hoisted() {
  return recursive();
}
function recursive() {
  return hoisted();
}
export { hoisted as PUT, recursive as DELETE, cache as "string name" };
export { remote, other as renamed } from "./remote.js";
export * as everything from "./everything.js";
export * from "./kept.js";
export default function Page() {
  return loader();
}
`;

const JSX_ROUTE = `
import { Show as When, For } from "solid-js";
import { Icon, Avatar } from "./icons.jsx";
import * as UI from "./ui.jsx";
import { lower } from "./lower.jsx";
import { tooltip } from "./directives.js";
import "./page.css";

const Header = props => <header class="top"><UI.Title>{props.title}</UI.Title></header>;
const Unused = () => <Avatar />;
const lowercase = () => <div use:tooltip={lower}>{/* comment */}</div>;
export const route = { preload: () => lowercase, info: { title: "Page &amp; more" } };
export const Layout = props => (
  <>
    <Header title="x" />
    <When when={props.open} fallback={(print(404), <p>none</p>)}>
      {props.children}
    </When>
  </>
);
export function Sidebar() {
  return <For each={[]}>{item => <Icon name={item} />}</For>;
}
function print(status) {
  return status;
}
export default function Page(props) {
  const [open, setOpen] = [true];
  const { title, subtitle: renamed = "none" } = props;
  return (
    <Layout open={open} onClick={() => setOpen(false)}>
      {title} {renamed}
    </Layout>
  );
}
`;

const TS_ROUTE = `
import type { Secret } from "./types.ts";
import { type Inline, value as importedValue } from "./mixed.ts";
import { onlyAsType, onlyInAnnotation } from "./types.ts";
import { initializeSecret, register } from "./secret.ts";
import legacyRequire = require("./legacy");

export type Alias = typeof secret;
export interface Shape extends Base<typeof secret> {
  method(argument: string): void;
}
interface Local {
  key: typeof helper;
}
type TypeOnly = typeof onlyAsType;
export declare const declared: string, GET_DECLARED: () => string;
export declare function declaredFunction(name: string): void;
export declare class DeclaredClass {}
export enum Status {
  Open = "open",
  Closed = "closed"
}
const enum Hidden {
  A
}
export abstract class Shape2<T> implements Base<T> {
  abstract area(): number;
  constructor(private readonly store: Inline) {}
}
export const secret = initializeSecret() satisfies Secret;
export const helper = <T,>(input: T): T => input;
export const cast = importedValue as unknown as Secret;
export function overloaded(input: string): string;
export function overloaded(input: number): number;
export function overloaded(input: any) {
  return register(input);
}
namespace Data {
  export const value = "namespace";
  const inner = value;
  export function read() {
    return inner;
  }
}
declare module "augmented" {
  export const value: string;
}
export const first = register(() => second), second = register(() => first);
export const GET = (input: Local, other: typeof onlyInAnnotation): TypeOnly | null => {
  type Inner = typeof input;
  const unused: Inner = input;
  return Data.read() as never;
};
export const POST = () => helper(secret);
export { type Alias as AliasAgain, legacyRequire };
export type { Secret };
export default class Controller {
  handle = POST;
}
`;

const TSX_ROUTE = `
import { createAsync, query, type RouteDefinition } from "@solidjs/router";
import { createSignal, For, type JSX } from "solid-js";
import { readFile } from "node:fs/promises";
import { Card } from "./card.tsx";
import "./route.css";

const getData = query(async (name: string) => {
  "use server";
  return readFile(name, "utf8");
}, "data");

export const route = {
  preload: () => getData("name")
} satisfies RouteDefinition;

export function GET({ request }: { request: Request }): Response {
  return new Response(request.url);
}
export const POST = async (event: { request: Request }) => {
  const body = await event.request.text();
  return new Response(body);
};
export const meta = { title: "Page" } as const;

const Row = <T extends { id: string }>(props: { item: T; children?: JSX.Element }) => (
  <Card<T> item={props.item} data-id={props.item.id}>
    {props.children}
  </Card>
);

export default function Page(): JSX.Element {
  const data = createAsync(() => getData("name"));
  const [count, setCount] = createSignal(0);
  return (
    <For each={[data()!]}>
      {item => (
        <Row item={{ id: item }}>
          <button onClick={() => setCount(c => c + 1)}>{count()}</button>
        </Row>
      )}
    </For>
  );
}
`;

const SCOPES_ROUTE = `
import { shadowed, inDefault, label, inCatch, inSwitch, inLoop, reassignedImport } from "./scopes.js";
import { keyOnly, memberOnly, propertyOnly } from "./names.js";

const outer = 1;
export const POST = () => [shadowed, inDefault, label, inCatch, inSwitch, inLoop, keyOnly, memberOnly, propertyOnly];
export const GET = function named(shadowed, value = outer) {
  var inDefault = 1;
  label: for (const inLoop of [value]) {
    if (inLoop) break label;
  }
  try {
    named();
  } catch (inCatch) {
    return inCatch;
  }
  switch (value) {
    case 1: {
      let inSwitch = 2;
      return inSwitch + inDefault;
    }
  }
  return { keyOnly: 1, ["computed"]: shadowed }.memberOnly;
};
export const OPTIONS = () => {
  class propertyOnly {
    keyOnly = 1;
    static memberOnly() {
      return arguments;
    }
  }
  return propertyOnly;
};
export const HEAD = () => {
  const dead = 1;
  type OnlyType = typeof dead;
  function deadFunction() {}
  type OnlyFunction = typeof deadFunction;
  for (let i = 0, j: typeof i; i < 1; i++) {}
  return null as unknown as OnlyType | OnlyFunction;
};
`;

const NO_SEMICOLONS_ROUTE = `
import { db } from "./db.js"
const kept = 1
export function POST() { return db }
export const GET = () => kept
export const PATCH = () => db
;[kept].forEach(print)
function print() {}
`;

const NOTHING_PICKED_ROUTE = `
import { db } from "./db.js";
// A comment that only the removed export can claim.
export const POST = () => db;
`;

const ROUTES: [ext: string, code: string, exports: string[]][] = [
  [
    "js",
    JS_ROUTE,
    [
      "loader",
      "stream",
      "Store",
      "GET",
      "POST",
      "first",
      "second",
      "third",
      "destructured",
      "deep",
      "reassigned",
      "assignedFunction",
      "PUT",
      "DELETE",
      "string name",
      "remote",
      "renamed",
      "everything"
    ]
  ],
  ["jsx", JSX_ROUTE, ["route", "Layout", "Sidebar"]],
  [
    "ts",
    TS_ROUTE,
    [
      "Alias",
      "Shape",
      "declared",
      "GET_DECLARED",
      "declaredFunction",
      "DeclaredClass",
      "Status",
      "Shape2",
      "secret",
      "helper",
      "cast",
      "overloaded",
      "first",
      "second",
      "GET",
      "POST",
      "legacyRequire"
    ]
  ],
  ["tsx", TSX_ROUTE, ["route", "GET", "POST", "meta"]],
  ["js", SCOPES_ROUTE, ["GET", "POST", "OPTIONS", "HEAD"]],
  ["js", NO_SEMICOLONS_ROUTE, ["GET", "POST", "PATCH"]],
  ["js", NOTHING_PICKED_ROUTE, ["POST"]]
];

describe("pickExports compared with the Babel pass", () => {
  for (const [ext, code, exports] of ROUTES) {
    const picks = [
      ["default", "$css"],
      ["default"],
      ["$css"],
      ["missing"],
      exports.slice(0, 2),
      ...exports.map(name => [name]),
      ...exports.map(name => ["default", name])
    ];
    describe(`.${ext} route exporting ${exports.slice(0, 3).join(", ")}`, () => {
      it.each(picks.map(names => [names.join("+"), names] as const))("pick %s", (_, names) => {
        const expected = babel(code, names, ext);
        const actual = pick(code, names, ext);
        // The plugin treats Babel's empty output as "leave the module alone".
        if (!expected) expect(actual).toBeUndefined();
        else expect(normalize(actual!)).toEqual(normalize(expected));
      });
    });
  }
});

// The assertions on `babel()` pin what the Babel pass emits in each case.
describe("pickExports where it deliberately differs from the Babel pass", () => {
  it("keeps array pattern elements at their positions", () => {
    const code = `
      const [getter, setter, third] = create();
      export const POST = () => setter;
      export const GET = () => [getter, third];
    `;
    expect(babel(code, ["GET"])).toContain("const [getter, third]");
    expect(pick(code, ["GET"])).toMatch(/const \[getter, , third\]/);
  });

  it("keeps a removed slot's siblings bound to the same array index", () => {
    const code = `
      const [read, write] = create();
      export const POST = () => read;
      export const GET = () => write;
    `;
    expect(babel(code, ["GET"])).toContain("const [write]");
    expect(pick(code, ["GET"])).toMatch(/const \[, write\]/);
  });

  it("keeps the siblings of a live object rest element", () => {
    const code = `
      const { secret, ...rest } = load();
      export const POST = () => secret;
      export const GET = () => rest;
    `;
    expect(babel(code, ["GET"])).not.toContain("secret");
    expect(pick(code, ["GET"])).toContain("const { secret, ...rest }");
  });

  it("keeps a computed key of a kept object rest sibling", () => {
    const code = `
      export const key = "secret";
      const { [key]: secret, ...rest } = load();
      export const POST = () => secret;
      export const GET = () => rest;
    `;
    const output = pick(code, ["GET"])!;
    expect(output).toContain(`const key = "secret"`);
    expect(output).toContain("[key]: secret, ...rest");
  });

  it("keeps bindings used by a named function expression", () => {
    const code = `
      export const helper = () => 1;
      schedule(function loop() {
        helper();
        schedule(loop);
      });
      export const GET = () => "ok";
    `;
    expect(babel(code, ["GET"])).not.toContain("const helper");
    expect(pick(code, ["GET"])).toContain("const helper = () => 1");
  });

  it("does not remove a named function expression from its call", () => {
    const code = `
      register(function self() {
        type Self = typeof self;
      });
      export const GET = () => "ok";
    `;
    expect(babel(code, ["GET"])).toContain("register();");
    expect(pick(code, ["GET"])).toContain("register(function self()");
  });

  it("resolves a function's name outside its own scope", () => {
    const code = `
      export function helper() {
        const helper = 1;
        return helper;
      }
      export const GET = () => helper();
    `;
    expect(babel(code, ["GET"])).not.toContain("function helper");
    expect(pick(code, ["GET"])).toContain("function helper()");
  });

  it.each([
    ["call argument", "foo(a = function () {});", "foo();"],
    ["initializer", "const b = (a = function () {}); foo(b);", "const b;"],
    ["class field", "new (class { x = (a = () => 1); })();", "x;"],
    ["arrow body", "foo(() => a = function () {});", "foo(() => {});"]
  ])("keeps the target of an assignment that is not a statement: %s", (_, statement, emitted) => {
    const code = `export let a; ${statement} export const GET = 1;`;
    expect(babel(code, ["GET"])).toContain(emitted);
    expect(pick(code, ["GET"])).toContain("let a;");
    expect(pick(code, ["GET"])).toContain(statement);
  });

  it("removes an unpicked specifier's declaration wherever it is written", () => {
    const before = `
      import { db } from "./db.ts";
      const handler = () => db;
      export { handler };
      export const GET = () => "ok";
    `;
    const after = `
      import { db } from "./db.ts";
      export { handler };
      const handler = () => db;
      export const GET = () => "ok";
    `;
    expect(babel(before, ["GET"])).not.toContain("handler");
    expect(babel(after, ["GET"])).toContain("const handler");
    expect(pick(before, ["GET"])).not.toContain("handler");
    expect(pick(after, ["GET"])).not.toContain("handler");
    expect(pick(after, ["GET"])).not.toContain("db");
  });

  it("keeps the declaration of a for-of loop", () => {
    const code = `
      export const GET = () => {
        for (const item of items()) {
          type Item = typeof item;
        }
      };
    `;
    expect(() => babel(code, ["GET"])).toThrow(/Property left of ForOfStatement/);
    expect(pick(code, ["GET"])).toContain("for (const item of items())");
  });
});

describe("pickExports", () => {
  it("resolves a switch discriminant outside the switch's scope", () => {
    const code = `
      export const value = 1;
      export const GET = () => {
        switch (value) {
          default:
            let value = 2;
            return value;
        }
      };
    `;
    expect(pick(code, ["GET"])).toContain("const value = 1");
    expect(normalize(pick(code, ["GET"])!)).toEqual(normalize(babel(code, ["GET"])!));
  });

  it("keeps the source text of what stays", () => {
    const code = `export   const GET=()=>'ok' // trailing\n\nexport const POST = 1\n`;
    expect(pick(code, ["GET"])).toBe(`export   const GET=()=>'ok' // trailing\n\n`);
  });

  it("leaves the module alone when nothing would remain", () => {
    expect(pick(`export const POST = () => 1;`, ["GET"])).toBeUndefined();
  });

  it("reads source positions in UTF-16 code units", () => {
    const code = `const é = "🎉ü";\nexport const POST = "🎉";\nexport const GET = () => é;\n`;
    expect(pick(code, ["GET"])).toBe(`const é = "🎉ü";\nexport const GET = () => é;\n`);
  });

  it("does not join the neighbors of a removed statement", () => {
    const code = `const kept = 1\nexport function POST() {}\n(globalThis.value = kept)\nexport const GET = 1`;
    const output = pick(code, ["GET"])!;
    expect(normalize(output)).toEqual(normalize(babel(code, ["GET"])!));
    expect(output).toContain("const kept = 1\n;");
  });

  it("parses .ts modules as TypeScript without JSX", () => {
    const code = `export const GET = <T>(x: T) => x;
export const POST = <string>value;
`;
    expect(pick(code, ["GET"], "ts")).toBe(`export const GET = <T>(x: T) => x;
`);
  });

  it.each([
    ["qualified", "ns.Thing"],
    ["direct", "ns"]
  ])("keeps what a %s import alias references", (_, target) => {
    const code = `
      export const ns = create();
      import Alias = ${target};
      export const GET = () => Alias;
    `;
    const output = pick(code, ["GET"])!;
    expect(output).toContain("const ns = create()");
    expect(output).not.toContain("export const ns");
    expect(output).toContain(`import Alias = ${target};`);
  });

  it("does not trip over parenthesized sequences in JSX", () => {
    const code = `export default () => <A b={(c(), <d />)} />;\nexport const POST = 1;`;
    expect(pick(code, ["default"])).toContain("b={(c(), <d />)}");
  });

  it("removes specifiers next to a default or namespace import", () => {
    const code = `
      import a, { /* } */ b, c, } from "./x";
      import d, * as e from "./y";
      import f, { g } from "./z";
      type T = typeof b | typeof c | typeof e | typeof f;
      export const GET = () => [a, d, g];
    `;
    const output = pick(code, ["GET"])!;
    expect(output).toMatch(/import a from "\.\/x"/);
    expect(output).toMatch(/import d from "\.\/y"/);
    expect(output).toMatch(/import \{ g \} from "\.\/z"/);
    expect(normalize(output)).toEqual(normalize(babel(code, ["GET"])!));
  });

  it("handles decorators, which the Babel pass could not parse", () => {
    const code = `
      @tracked export class Removed {}
      export @tracked class AlsoRemoved {}
      @tracked export default class Page {}
      @tracked export class Kept {}
      export const GET = () => Kept;
    `;
    expect(() => babel(code, ["GET"])).toThrow();
    const output = pick(code, ["GET"])!;
    expect(output).not.toContain("Removed");
    expect(output).not.toContain("Page");
    expect(output).not.toContain("export class Kept");
    expect(output).toContain("@tracked class Kept");
    expect(output.match(/@tracked/g)).toHaveLength(1);
    expect(parseSync("output.tsx", output, { lang: "tsx" }).errors).toEqual([]);
  });

  it("reports syntax errors with the module id", () => {
    expect(() => pick(`export const = 1;`, ["GET"])).toThrow(
      /Failed to parse \/routes\/route\.tsx/
    );
  });

  it("maps kept code back to the original source", () => {
    const code = [
      `import { db } from "./db.ts";`,
      `export const POST = () => db;`,
      `export const a = 1, GET = () => "ok";`,
      `export default function Page() {}`,
      `const marker = "still here";`
    ].join("\n");
    const moduleId = id("ts", ["GET"]);
    const result = pickExports(code, moduleId, ["GET"])!;
    expect(result.map.sources).toEqual([moduleId]);
    expect(result.map.sourcesContent).toEqual([code]);

    const lines = result.code.split("\n");
    const locate = (text: string) => {
      const line = lines.findIndex(content => content.includes(text));
      return originalPositionFor(new TraceMap(result.map as any), {
        line: line + 1,
        column: lines[line]!.indexOf(text)
      });
    };
    expect(locate("GET")).toMatchObject({ source: moduleId, line: 3, column: 20 });
    expect(locate(`"ok"`)).toMatchObject({ source: moduleId, line: 3, column: 32 });
    expect(locate(`"still here"`)).toMatchObject({ source: moduleId, line: 5, column: 15 });
  });
});
