/**
 * Part A2 harness — checks every factual claim in
 *   task-5/part-a/a2-opensource/01-ms.md
 *   task-5/part-a/a2-opensource/02-fast-deep-equal.md
 *   task-5/part-a/a2-opensource/03-picomatch-scan.md
 *   task-5/part-a/a2-opensource/ai-comparison.md
 *
 * Run:
 *   node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
 *
 * The three libraries are CommonJS, so they are loaded with createRequire rather than
 * with import(). Vitest's ESM interop would otherwise pick the default export and the
 * es6/ variants would not be reachable.
 *
 * If any assertion below fails, the corresponding .md file is wrong and gets fixed.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const ms: (value: unknown, options?: { long?: boolean }) => number | undefined =
  require("ms");
const equal: (a: unknown, b: unknown) => boolean =
  require("fast-deep-equal/es6");
const picomatch = require("picomatch");
const scan: (
  input: string,
  options?: Record<string, unknown>
) => Record<string, unknown> = picomatch.scan;

// ---------------------------------------------------------------------------
// ms v2.1.3
// ---------------------------------------------------------------------------

describe("A2.1 — ms: what it actually does", () => {
  it("parses units, including the non-obvious min/msec aliases", () => {
    expect(ms("1h")).toBe(3_600_000);
    expect(ms("5min")).toBe(300_000);
    expect(ms("2d")).toBe(172_800_000);
    expect(ms("200ms")).toBe(200);
    expect(ms("1msec")).toBe(1);
    expect(ms("2weeks")).toBe(1_209_600_000);
  });

  it("a year is 365.25 days, not 365", () => {
    // Row 2 of the ai-comparison table. The general-knowledge answer says 365.
    // ms() is typed `string | number | undefined`, so the valid-string result is
    // narrowed here rather than repeating that cast on every assertion.
    const year = ms("1y") as number;
    expect(year).toBe(31_557_600_000);
    expect(year).not.toBe(31_536_000_000);
    expect(year / 86_400_000).toBe(365.25);
  });

  it("a bad STRING returns undefined and does not throw", () => {
    // Row 1 — the single most consequential correction in the ms comparison.
    expect(ms("5 apples")).toBeUndefined();
    expect(() => ms("5 apples")).not.toThrow();
    expect(ms("nonsense")).toBeUndefined();
  });

  it("a bad TYPE does throw", () => {
    expect(() => ms({} as unknown)).toThrow();
    expect(() => ms([] as unknown)).toThrow();
    expect(() => ms(true as unknown)).toThrow();
  });

  it("guards on string length before running the regex", () => {
    expect(ms("x".repeat(101))).toBeUndefined();
    expect(ms("x".repeat(99))).toBeUndefined();
  });

  it("reports a misleading message for Infinity, because JSON.stringify turns it into null", () => {
    // Row 4 — a real cosmetic bug in the library.
    expect(() => ms(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => ms(Number.POSITIVE_INFINITY)).toThrow(/val=null/);
    expect(JSON.stringify(Number.POSITIVE_INFINITY)).toBe("null");
  });

  it("returns a spelled-out string when asked for long format", () => {
    expect(ms(3_600_000, { long: true })).toBe("1 hour");
    expect(ms(86_400_000, { long: true })).toBe("1 day");
  });
});

// ---------------------------------------------------------------------------
// fast-deep-equal (the ES6 build — the one actually in node_modules/es6)
// ---------------------------------------------------------------------------

describe("A2.2 — fast-deep-equal/es6: what it actually does", () => {
  it("compares plain objects by own enumerable keys", () => {
    expect(equal({ plan: "Pro", amount: 500_000 }, { plan: "Pro", amount: 500_000 })).toBe(true);
    expect(equal({ a: 1 }, { a: 2 })).toBe(false);
    expect(equal({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(equal({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
  });

  it("compares Maps by VALUE and order-independently", () => {
    expect(
      equal(new Map([["a", 1], ["b", 2]]), new Map([["b", 2], ["a", 1]]))
    ).toBe(true);
    expect(equal(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(equal(new Map([["a", 1]]), new Map([["a", 1], ["b", 2]]))).toBe(false);
  });

  it("compares Sets by IDENTITY, not deeply — the most surprising behaviour", () => {
    // Row 1 of the fast-deep-equal comparison, and the error most likely to survive
    // review because the mental model ("deep equality handles Sets") sounds right.
    expect(equal(new Set([{ x: 1 }]), new Set([{ x: 1 }]))).toBe(false);
    expect(equal(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(equal(new Set([1]), new Set([2]))).toBe(false);
  });

  it("compares Map KEYS by identity but Map VALUES deeply", () => {
    const keyA = { id: 1 };
    const keyB = { id: 1 };

    expect(equal(new Map([[keyA, "v"]]), new Map([[keyB, "v"]]))).toBe(false);
    expect(equal(new Map([["k", { x: 1 }]]), new Map([["k", { x: 1 }]]))).toBe(true);
  });

  it("has NO cycle detection in the es6 build", () => {
    // Row 2. The stack array lives in the ES5 build only.
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;

    expect(() => equal(a, b)).toThrow(/Maximum call stack size exceeded/);
    // Same reference short-circuits, so this one is fine.
    expect(equal(a, a)).toBe(true);
  });

  it("treats 0 and -0 as EQUAL, because it uses === and not Object.is", () => {
    // Row 3.
    expect(0 === -0).toBe(true);
    expect(equal(0, -0)).toBe(true);
    expect(Object.is(0, -0)).toBe(false);
  });

  it("treats two NaNs as equal, via the final fallback branch", () => {
    // `NaN === NaN` is false, but the compiler folds a literal-vs-literal comparison
    // and flags it, so the assertion goes through a value it cannot fold.
    const nan = NaN;
    expect(nan === nan).toBe(false);
    expect(equal(nan, nan)).toBe(true);
    expect(equal({ d: NaN }, { d: NaN })).toBe(true);
  });

  it("rejects different constructors at the first gate, before any deep work", () => {
    expect(equal(new Date(0), {})).toBe(false);
    expect(equal([], {})).toBe(false);
    expect(equal(new Map(), new Set())).toBe(false);
  });

  it("handles Dates, RegExps and typed arrays", () => {
    expect(equal(new Date(0), new Date(0))).toBe(true);
    expect(equal(new Date(0), new Date(1))).toBe(false);
    expect(equal(/x/g, /x/g)).toBe(true);
    expect(equal(/x/g, /x/i)).toBe(false);
    expect(equal(new Float64Array([1, 2]), new Float64Array([1, 2]))).toBe(true);
    expect(equal(new Float64Array([1, 2]), new Float64Array([2, 1]))).toBe(false);
  });

  it("contains one dead variable, envHasBigInt64Array, that is never read", () => {
    // Not assertable through the public API, so assert it through the source.
    const fs = require("node:fs");
    const source = fs.readFileSync(
      require.resolve("fast-deep-equal/es6/index.js"),
      "utf8"
    );
    const occurrences = source.split("envHasBigInt64Array").length - 1;

    expect(occurrences).toBe(1); // one declaration, one assignment, and no reads
  });
});

// ---------------------------------------------------------------------------
// picomatch.scan
// ---------------------------------------------------------------------------

describe("A2.3 — picomatch.scan: what it actually does", () => {
  it("splits a nested glob into a literal base and a glob", () => {
    const state = scan("src/**/*.test.ts");
    expect(state.base).toBe("src");
    expect(state.glob).toBe("**/*.test.ts");
    expect(state.isGlob).toBe(true);
    expect(state.start).toBe(0);
  });

  it("reports isGlobstar FALSE for a globstar pattern unless `parts` is requested", () => {
    // Not obvious from reading, and the opposite of what the flag name suggests.
    // By default the scan loop stops at the FIRST `*`, so the second `*` that would
    // set isGlobstar is never reached. It is the `parts` pass — not `tokens` — that
    // walks the whole pattern and sets the flag.
    expect(scan("src/**/*.test.ts").isGlobstar).toBe(false);
    expect(scan("src/**/*.ts", { tokens: true }).isGlobstar).toBe(false);
    expect(scan("src/**/*.ts", { parts: true }).isGlobstar).toBe(true);
    expect(scan("src/**/*.ts", { tokens: true, parts: true }).isGlobstar).toBe(true);
  });

  it("DROPS the leading slash on the glob, matching the library's documented example", () => {
    // CORRECTION. My hand trace predicted glob: '/*.js' and claimed the shipped
    // README was wrong for 2.3.2. Execution says glob: '*.js' — the README is right
    // and my trace was wrong. See the correction notice at the top of
    // 03-picomatch-scan.md. The mechanism: lastIndex is set to index + 1, so it
    // points PAST the slash; base = slice(0, lastIndex) therefore carries a trailing
    // slash which step 8 strips, and glob = slice(lastIndex) starts AFTER the slash.
    const state = scan("foo/bar/*.js");
    expect(state.base).toBe("foo/bar");
    // picomatch has no bundled type declarations, so ScanState.glob is `unknown`.
    const glob = state.glob as string;
    expect(glob).toBe("*.js");
    expect(glob.startsWith("/")).toBe(false);
  });

  it("treats a leading ! as negation and reports it in prefix", () => {
    const state = scan("!src/*.ts");
    expect(state.negated).toBe(true);
    expect(state.negatedExtglob).toBe(false);
    expect(state.prefix).toBe("!");
    expect(state.base).toBe("src");
  });

  it("treats !( as a negated EXTglob, not as negation", () => {
    // Row 3 — the general-knowledge answer over-generalises the `!` rule.
    const state = scan("!(a|b)");
    expect(state.negatedExtglob).toBe(true);
    expect(state.negated).toBe(false);
    expect(state.isExtglob).toBe(true);
    expect(state.isGlob).toBe(true);
    expect(state.base).toBe("");
  });

  it("strips a leading ./ into the prefix", () => {
    const state = scan("./src/*.ts");
    expect(state.prefix).toBe("./");
    expect(state.base).toBe("src");
    expect(state.start).toBe(2);
  });

  it("treats an UNCLOSED bracket as a literal, not as a glob", () => {
    // Row 2 — the general-knowledge answer says malformed patterns become globs.
    const state = scan("src/[abc.ts");
    expect(state.isGlob).toBe(false);
    expect(state.isBracket).toBe(false);
    expect(state.glob).toBe("");
    expect(state.base).toBe("src/[abc.ts");
  });

  it("marks a closed bracket as a glob", () => {
    const state = scan("src/[abc].ts");
    expect(state.isGlob).toBe(true);
    expect(state.isBracket).toBe(true);
  });

  it("clears isGlob as well as isExtglob when noext is set", () => {
    // Row 4 — an omission with real consequences.
    const withExt = scan("a/@(b|c).ts");
    expect(withExt.isExtglob).toBe(true);
    expect(withExt.isGlob).toBe(true);

    const withoutExt = scan("a/@(b|c).ts", { noext: true });
    expect(withoutExt.isExtglob).toBe(false);
    expect(withoutExt.isGlob).toBe(false);
  });

  it("never throws on hostile input", () => {
    // Row 6 — the general-knowledge answer claims malformed patterns throw.
    for (const input of [
      "src/{a,b",
      "src/[abc.ts",
      "src\\",
      "",
      "**",
      "!!!",
      "((((",
      "}}}}",
    ]) {
      expect(() => scan(input)).not.toThrow();
    }
    expect(scan("").isGlob).toBe(false);
    expect(scan("src\\").isGlob).toBe(false);
  });

  it("reports maxDepth Infinity whenever a globstar is present", () => {
    const withGlobstar = scan("src/**/*.ts", { tokens: true, parts: true });
    expect(withGlobstar.maxDepth).toBe(Infinity);

    // One depth per non-globstar segment, so two segments means 2.
    const withoutGlobstar = scan("src/*.ts", { tokens: true, parts: true });
    expect(withoutGlobstar.maxDepth).toBe(2);
    expect(withoutGlobstar.parts).toEqual(["src", "*.ts"]);
  });

  it("serialises Infinity as null, which is a trap when logging scan output as JSON", () => {
    // maxDepth is Infinity for a globstar pattern, and JSON.stringify turns that
    // into null. Anything that persists scan output through JSON loses the
    // distinction between "infinite depth" and "no depth recorded".
    const state = scan("src/**/*.ts", { tokens: true, parts: true });
    expect(state.maxDepth).toBe(Infinity);
    expect(JSON.parse(JSON.stringify(state)).maxDepth).toBeNull();
  });

  it("reports no glob at all for a literal path", () => {
    const state = scan("src/index.ts");
    expect(state.isGlob).toBe(false);
    expect(state.glob).toBe("");
    expect(state.base).toBe("src/index.ts");
  });
});

// ---------------------------------------------------------------------------

describe("A2 — the libraries are the versions this exercise claims", () => {
  it("pins the versions, so the claims cannot silently rot", () => {
    expect(require("ms/package.json").version).toMatch(/^2\./);
    expect(require("fast-deep-equal/package.json").version).toMatch(/^3\./);
    expect(require("picomatch/package.json").version).toMatch(/^2\./);
  });

  it("resolves the three libraries from the installed toolchain", () => {
    // Not direct dependencies — ms and picomatch arrive transitively (via chokidar
    // and vite/vitest respectively), and fast-deep-equal comes in through the test
    // framework. Worth stating plainly, because "a library the project actually uses"
    // is doing real work in the brief and a transitive dependency is a weaker claim
    // than a direct one.
    for (const id of ["ms", "fast-deep-equal/es6", "picomatch"]) {
      expect(() => require.resolve(id)).not.toThrow();
    }

    const pkg = JSON.parse(
      require("node:fs").readFileSync("package.json", "utf8")
    );
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ["ms", "picomatch", "fast-deep-equal"]) {
      expect(declared[name]).toBeUndefined();
    }
  });
});