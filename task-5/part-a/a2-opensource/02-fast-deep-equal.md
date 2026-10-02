# A2.2 — `equal(a, b)` — MEDIUM

**Library:** [`fast-deep-equal`](https://www.npmjs.com/package/fast-deep-equal) v3.1.3
**Source read:** `node_modules/fast-deep-equal/es6/index.js` (72 lines)
**Why this one (medium):** it is the deep-equality function behind `expect(...).toEqual`
in this project's own test suite — Vitest and Chai depend on it. Every assertion in
`tests/payment-flow/*.test.ts` that compares an object is calling this. It is also a
good medium exercise because it is a **type-dispatch ladder with an ordering
dependency**: the branches are not independent, and reading them out of order produces
plausible but wrong pseudocode.

**Provenance:** written by an AI, so the brief's no-AI first pass is not met. See `ai-comparison.md`.
for where the AI's later account disagreed.

---

## Pseudocode

```
FUNCTION equal(a, b)
INPUTS:
  a (any value) — the first value to compare
  b (any value) — the second value to compare
OUTPUT: boolean — true if the two values are deeply equal
SIDE EFFECTS: NONE. No mutation of the inputs. Safe to call concurrently.
FAILS WHEN: never. It does not throw for any input pair, including circular
  structures — but a CIRCULAR input pair causes unbounded recursion and therefore a
  stack overflow, which is a crash rather than a return value. The ES5 build of this
  library had cycle detection; the ES6 build does not.
```

### Steps

1. IF `a` and `b` are the same value by strict identity (`===`)
   RETURN true. This covers every primitive, including `NaN`? No — see step 12.
2. OTHERWISE, IF `a` is truthy AND `b` is truthy AND both are objects
   (i.e. neither is `null`, since `typeof null === "object"`)
   2a. IF the two objects were built by DIFFERENT constructors
       RETURN false. This single line rejects `{a:1}` vs `new Map()`, `[]` vs `{}`,
       and `new Date(0)` vs `{}` — it is a fast type gate before any deep work.
   2b. IF `a` is an array
       2b-i.  IF the two arrays have different lengths, RETURN false.
       2b-ii. FOR EACH index from the LAST index down to 0
                 IF the elements at that index are not deeply equal, RETURN false.
                 END FOR
       2b-iii. RETURN true.
   2c. OTHERWISE IF both are Maps
       2c-i.   IF the sizes differ, RETURN false.
       2c-ii.  FOR EACH entry in the map `a`
                   IF the map `b` does not contain that key, RETURN false.
                   END FOR
       2c-iii. FOR EACH entry in the map `a`
                   IF the value in `b` for that key is not deeply equal to the value
                   in `a`, RETURN false.
                   END FOR
       2c-iv.  RETURN true.
       Note this is two separate loops on purpose: the first establishes that every
       key of `a` exists in `b`, the second compares values. Combined with the size
       check, that makes the comparison order-independent — a Map is a set of pairs,
       not a list, so `[a→1, b→2]` and `[b→2, a→1]` are equal.
   2d. OTHERWISE IF both are Sets
       2d-i.   IF the sizes differ, RETURN false.
       2d-ii.  FOR EACH value in the set `a`
                   IF the set `b` does not contain that value, RETURN false.
                   END FOR
       2d-iii. RETURN true.
       Note the asymmetry with 2c: Sets compare by IDENTITY, not deeply, because a
       Set's `has` uses SameValueZero. So `new Set([{a:1}])` and `new Set([{a:1}])`
       are NOT equal, even though their contents look identical. Maps are the
       opposite: keys are identity-compared but VALUES are deeply compared.
   2e. OTHERWISE IF both are typed-array views (any of Int8Array, Uint8Array,
       Float64Array, DataView, and so on)
       2e-i.   IF the lengths differ, RETURN false.
       2e-ii.  FOR EACH index from the last down to 0
                   IF the bytes differ, RETURN false.
                   END FOR
       2e-iii. RETURN true.
       Note this branch is placed BEFORE the Date and valueOf branches below, which
       matters: a typed array does not have a meaningful `valueOf` comparison, so if
       the ordering were reversed a `Float64Array` would fall through to step 2g and
       be compared as a plain object with numeric keys — which would happen to work,
       but only by accident.
   2f. OTHERWISE IF the shared constructor is RegExp
       RETURN true only if the pattern source text is identical AND the flags are
       identical. Two regexes with the same source but different flags are NOT equal.
   2g. OTHERWISE IF the object defines its OWN `valueOf` — that is, `valueOf` is not
       the one inherited from Object
       RETURN true only if the two `valueOf()` results are strictly identical.
       This is the branch that makes Dates work: `Date` overrides `valueOf`, so two
       dates are equal exactly when their numeric timestamps are.
   2h. OTHERWISE IF the object defines its OWN `toString`
       RETURN true only if the two `toString()` results are strictly identical.
       This catches anything that stringifies meaningfully.
   2i. OTHERWISE, treat both as plain objects
       2i-i.   SET the key list to the own ENUMERABLE STRING keys of `a`.
       2i-ii.  IF the count of those keys differs from the count of own enumerable
               string keys of `b`, RETURN false.
       2i-iii. FOR EACH key in that list, from last to first
                   IF `b` does not have that key as an OWN property, RETURN false.
               END FOR
       2i-iv.  FOR EACH key in that list, from last to first
                   IF `a[key]` and `b[key]` are not deeply equal, RETURN false.
               END FOR
       2i-v.   RETURN true.
       Note that the key count is `a`'s count only. Since 2a already guaranteed the
       same constructor, and 2i-iii guarantees `b` has every key of `a`, equal counts
       imply the key SETS are identical — so no separate check on `b`'s keys is
       needed. And because the loops run backwards, a failure is reported on the
       highest-numbered key first, which is a stable, reproducible order.
3. OTHERWISE (at least one of `a`/`b` is falsy, or at least one is a non-object
   primitive such as a number, string or boolean)
   RETURN true ONLY IF both `a` and `b` are not-equal-to-themselves — that is, both
   are `NaN`. This is the `NaN` handler: `NaN === NaN` is false, so without this
   line two NaNs would compare unequal.
```

**Note on the `envHasBigInt64Array` variable at the top of the file:** it is computed
and then never referenced. It is dead code — a leftover from a build template shared
with the TypeScript source (`src/index.jst`), where it guards BigInt array support.
Reading it as meaningful would be a mistake, so it is recorded here as deliberately
excluded rather than as a step.

---

## Hand traces

### Input 1 — NORMAL. Two equal plain objects

**Given:** `a = { plan: "Pro", amount: 500000 }`, `b = { plan: "Pro", amount: 500000 }`

| Step | What happens | Value |
|---|---|---|
| 1 | `a === b`? different object references | false |
| 2 | both truthy, both `typeof "object"` | enter |
| 2a | both constructors are `Object` | same, continue |
| 2b | `Array.isArray(a)`? no | skip |
| 2c | both Maps? no | skip |
| 2d | both Sets? no | skip |
| 2e | both typed-array views? no | skip |
| 2f | constructor is RegExp? no | skip |
| 2g | `a.valueOf` is `Object.prototype.valueOf`? yes, so the own-`valueOf` test fails | skip |
| 2h | `a.toString` is `Object.prototype.toString`? yes | skip |
| 2i-i | own enumerable string keys of `a` | `["plan", "amount"]` |
| 2i-ii | `b` has 2 such keys | equal, continue |
| 2i-iii | `b` has own `plan`? yes. `b` has own `amount`? yes | continue |
| 2i-iv | `"Pro"` vs `"Pro"` strictly identical → true. `500000` vs `500000` → true | continue |
| 2i-v | return | **`true`** |

**Expected:** `true`. ✓

### Input 2 — EDGE. Maps compared order-independently, Sets compared by identity

**Given:** `a = new Map([["a", 1], ["b", 2]])`,
`b = new Map([["b", 2], ["a", 1]])`

| Step | What happens | Value |
|---|---|---|
| 1 | different references | false |
| 2a | both `Map` | same, continue |
| 2b | not arrays | skip |
| 2c-i | both size 2 | equal |
| 2c-ii | does `b` have key `"a"`? yes. Key `"b"`? yes | continue |
| 2c-iii | `b.get("a")=1` vs `a.get("a")=1` → equal. `b.get("b")=2` vs `2` → equal | continue |
| 2c-iv | return | **`true`** |

**Now the Set probe**, `a = new Set([{x:1}])`, `b = new Set([{x:1}])`:

| Step | What happens | Value |
|---|---|---|
| 2a | both `Set` | same |
| 2d-i | both size 1 | equal |
| 2d-ii | does `b` contain the object `{x:1}` from `a`? Set membership uses identity, and these are two distinct objects | **`has` is false → RETURN false** |

**Expected:** Map `true`, Set `false` — even though the Sets hold structurally
identical contents. This is the single most surprising behaviour in the function and
it is entirely a consequence of using `Set.has`, which is identity-based, while using
recursive `equal` for Map values. Two Sets of equal-looking objects being unequal will
pass a test suite written from intuition and fail in production.

### Input 3 — INVALID. Different constructors, and NaN

**Probe A:** `a = new Date(0)`, `b = {}`

| Step | What happens | Value |
|---|---|---|
| 1 | different references | false |
| 2 | both truthy objects | enter |
| 2a | `a`'s constructor is `Date`, `b`'s is `Object` | **different → RETURN false** |

**Expected:** `false`, decided at step 2a without ever touching step 2g.

**Probe B:** `a = NaN`, `b = NaN`

| Step | What happens | Value |
|---|---|---|
| 1 | `NaN === NaN`? **false** — identity comparison fails | false |
| 2 | `a` is falsy? `Boolean(NaN)` is **false** | the object branch is not entered |
| 3 | `a !== a` is true AND `b !== b` is true | **RETURN true** |

**Expected:** `true`. This is the only way the function ever returns true after
failing identity, and it is a genuine special case: it is why
`expect({days: NaN}).toEqual({days: NaN})` passes.

**Probe C (the interesting one):** `a = 0`, `b = -0`

| Step | What happens | Value |
|---|---|---|
| 1 | `0 === -0`? **true** — JavaScript's `===` treats `+0` and `-0` as equal | **RETURN true** |

**Expected:** `true`. Many deep-equality libraries special-case `-0`/`+0` (`Object.is`
considers them different); this one inherits `===` semantics instead.

---

## Trace vs. execution

| # | Category | Input | Predicted | Executed | Agree? |
|---|---|---|---|---|---|
| 1 | normal | two equal objects | `true` | `true` | ✅ |
| 2a | edge | Maps, different insertion order | `true` | `true` | ✅ |
| 2b | edge | Sets holding equal-looking objects | `false` | `false` | ✅ |
| 3a | invalid | `new Date(0)` vs `{}` | `false` | `false` | ✅ |
| 3b | invalid | `NaN` vs `NaN` | `true` | `true` | ✅ |
| 3c | edge | `0` vs `-0` | `true` | `true` | ✅ |

**Discrepancies: none.** Step 2e came out right because the Date branch was traced
against the typed-array branch rather than in isolation. Describing the branches in
source order would have produced a version that compares typed arrays through
`valueOf`, which is wrong in a way that passes casual tests.

**Limitation found by reading, not by tracing:** there is no cycle detection.
`const a = {}; a.self = a; equal(a, a)` returns `true` at step 1 (same reference), but
`const a = {}; a.self = a; const b = {}; b.self = b; equal(a, b)` recurses forever
and throws `RangeError: Maximum call stack size exceeded`. The library documents this
and offers a non-recursive `createIsCircularArgumentPlugin` in `react.js` as the
mitigation. Since this project compares Prisma model instances in tests — which are
plain objects, not circular — it does not bite here, but it is a landmine for anyone
who later compares class instances with back-references.
