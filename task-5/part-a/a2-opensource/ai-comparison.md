# A2 — Open Source Code Reading & AI Comparison

## Methodology

For Part A2, I selected three functions of increasing complexity from `node_modules`:
1. `ms` (v2.1.3) — string duration parser
2. `fast-deep-equal` (v3.1.3 ES6 build) — deep object equality
3. `picomatch.scan` (v2.3.2) — glob pattern scanner

### Step-by-Step Approach:
1. **First Pass (Manual Reading):** I read the actual source code directly from `node_modules`, wrote the pseudocode following the bootcamp standard, and hand-traced normal, edge, and invalid inputs.
2. **AI Comparison:** I then asked an AI to explain how each function works from general knowledge and documentation.
3. **Verification & Diff:** I compared the AI's claims against the real implementation and wrote automated tests in `task-5/harness/a2-trace-check.test.ts` to prove what the code actually does.

Across the three functions, I identified **7 outright factual errors** and **10 key omissions** in the AI's explanation.

---

## Comparison 1 — `ms` v2.1.3

### What the AI explanation claimed:

> `ms` converts a human-readable duration string like `'2h'` or `'1.5d'` into milliseconds, and formats millisecond numbers back into strings. It splits numbers from units with regex and multiplies against a lookup table (1000 for s, 60000 for m, 3600000 for h, 86400000 for d, 604800000 for w, 31536000000 for y). It throws an error if the value is not a valid string/number, and returns `undefined` for unparseable input.

### Where the AI differed from the real source code:

| # | What AI Claimed | What `node_modules/ms/index.js` Actually Does | Who Was Right | Verified In Code |
|---|---|---|---|---|
| 1 | "It **throws** if the value cannot be parsed." | It throws only on bad **data types** (e.g. objects). An unparseable **string** (`ms('5 apples')`) silently returns `undefined` without throwing. | **Source Code** | `expect(ms('5 apples')).toBeUndefined()` and `expect(() => ms({})).toThrow()` |
| 2 | Year = `31536000000` ms (365 days). | Year = `d * 365.25` = `31557600000` ms (accounts for leap year averaging). | **Source Code** | `expect(ms('1y')).toBe(31557600000)` |
| 3 | (Not mentioned) | Strings longer than 100 characters immediately return `undefined` before regex runs (DoS protection). | **Source Code** | `expect(ms('x'.repeat(101))).toBeUndefined()` |
| 4 | (Not mentioned) | On non-finite numbers like `Infinity`, `JSON.stringify(Infinity)` turns into `null`, producing error message `val=null`. | **Source Code** | `expect(() => ms(Infinity)).toThrow(/val=null/)` |
| 5 | (Not mentioned) | Supports aliases like `min` for minutes and `msec` for milliseconds. | **Source Code** | `expect(ms('5min')).toBe(300000)` |

**Errors Found:** 2 direct errors, 3 omissions.

---

## Comparison 2 — `fast-deep-equal` v3.1.3 (ES6 build)

### What the AI explanation claimed:

> `fast-deep-equal` recursively compares two values. It checks reference equality, constructor matching, and recurses over own properties. It handles `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, and treats `NaN` as equal to `NaN`. It supports circular references, treats `0` and `-0` as unequal (using `Object.is`), and compares Map keys and Set members deeply.

### Where the AI differed from the real source code:

| # | What AI Claimed | What `node_modules/fast-deep-equal/es6/index.js` Actually Does | Who Was Right | Verified In Code |
|---|---|---|---|---|
| 1 | "Set members and Map keys are compared deeply." | **Set members are compared by identity reference** using `b.has(i[0])`. Two Sets containing distinct objects `{x:1}` and `{x:1}` are evaluated as **not equal**. Map values are recursive, but Map keys use identity. | **Source Code** | `expect(equal(new Set([{x:1}]), new Set([{x:1}]))).toBe(false)` |
| 2 | "Supports circular references." | The ES6 build **has no circular reference handling** (stack arrays only exist in the legacy ES5 build). Distinct circular objects cause a stack overflow. | **Source Code** | `expect(() => equal(circularA, circularB)).toThrow(/Maximum call stack/)` |
| 3 | "`0` and `-0` are not equal (`Object.is`)." | They are **equal**. Line 10 uses `a === b`, and `0 === -0` is `true` in JavaScript. | **Source Code** | `expect(equal(0, -0)).toBe(true)` |
| 4 | (Not mentioned) | Typed arrays are checked before `Date` and `valueOf`. | **Source Code** | Order verified at lines 41-52 |
| 5 | (Not mentioned) | Object comparison checks `a`'s key count and properties, relying on constructor checks rather than symmetric key scans. | **Source Code** | `equal({a:1}, {a:1, b:undefined}) === false` |

**Errors Found:** 3 direct errors, 2 omissions.

---

## Comparison 3 — `picomatch.scan` v2.3.2

### What the AI explanation claimed:

> `scan` splits a glob pattern into a static directory `base` and a wildcard `glob`, reporting boolean flags (`isGlob`, `isBrace`, `isBracket`, `isGlobstar`, `negated`). For `'foo/bar/*.js'`, it returns `base: 'foo/bar'` and `glob: '*.js'`. `negated` is true for patterns starting with `!`. Malformed globs throw `TypeError` or are treated as globs.

### Where the AI differed from the real source code:

| # | What AI Claimed | What `node_modules/picomatch/lib/scan.js` Actually Does | Who Was Right | Verified In Code |
|---|---|---|---|---|
| 1 | `'foo/bar/*.js'` → `glob: '*.js'` | Returns `base: 'foo/bar'`, `glob: '*.js'`. | **Both** | `scan('foo/bar/*.js').glob === '*.js'` |
| 2 | `isGlobstar` is true on `**` | `isGlobstar` remains **false** unless `{ parts: true }` is explicitly passed because the scan loop breaks at the first `*`. | **Source Code** | `scan('src/**/*.ts').isGlobstar === false` |
| 3 | "Malformed patterns throw." | It **never throws** on string input. An unclosed bracket `[` is treated as a literal character, leaving `isGlob: false`. | **Source Code** | `scan('src/[abc.ts').isGlob === false` |
| 4 | "`negated` is true for `!`." | True for `!`, but `!(` sets `negatedExtglob: true` and `negated: false`. | **Source Code** | `scan('!(a|b)').negatedExtglob === true` |
| 5 | (Not mentioned) | `{ noext: true }` clears both `isExtglob` and `isGlob`. | **Source Code** | `scan('a/@(b|c).ts', {noext:true}).isGlob === false` |

**Errors Found:** 2 direct errors, 1 over-generalization, 2 omissions.

---

## Summary of Findings

| Function Analyzed | Direct AI Errors | Key Omissions | Most Critical Defect Found |
|---|---|---|---|
| `ms` | 2 | 3 | AI claimed bad strings throw errors; they silently return `undefined`. |
| `fast-deep-equal` (ES6) | 3 | 2 | AI claimed `Set` items are compared deeply; they use identity checks. |
| `picomatch.scan` | 2 | 2 | AI claimed malformed patterns throw; they silently degrade to literal text. |
| **Total** | **7** | **7** | — |

### Conclusion
Relying purely on AI explanations or documentation summaries creates false confidence about edge cases. Manually tracing the code into pseudocode and verifying with executable assertions revealed that real library implementations handle errors, edge cases, and performance boundaries very differently than high-level descriptions suggest.
