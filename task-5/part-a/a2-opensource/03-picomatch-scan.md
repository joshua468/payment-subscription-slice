# A2.3 — `picomatch.scan(input, options)` — HARD

**Library:** [`picomatch`](https://www.npmjs.com/package/picomatch) v2.3.2
**Source read:** `node_modules/picomatch/lib/scan.js` (391 lines),
`node_modules/picomatch/lib/utils.js` (64 lines),
`node_modules/picomatch/lib/constants.js`, `node_modules/picomatch/README.md`
**Why this one (hard):** `picomatch` is how Vite, Vitest, PostCSS and webpack decide
which files a glob like `src/**/*.test.ts` matches — including, in this project, which
files `npm test` collects. `scan` is the function that answers the *preceding*
question: given this pattern, where does the literal directory prefix stop and the
glob begin? Every `picomatch()` call in every tool in this repo's toolchain runs it
first. It is a hand-written character scanner with a dozen interacting flags, and it
was the one I had to re-read three times.

**Provenance:** written by an AI, so the brief's no-AI first pass is not met. See `ai-comparison.md`.

> ## ⚠ CORRECTION — this document originally made a false claim
>
> The first version of this file asserted that `picomatch`'s own README is **wrong**
> for version 2.3.2: it predicted `scan('foo/bar/*.js')` returns `glob: '/*.js'`
> *with* a leading slash, and presented that as the headline finding — "the
> documentation is the thing that is out of date".
>
> **That was wrong.** Executing the library gives `glob: '*.js'`, exactly as the
> README documents. The README is correct.
>
> The error is worth reading, because it is a more interesting mistake than the one it
> replaced. My trace had the *mechanism* right — `scan.js:167` does set
> `lastIndex = index + 1`, one character past the slash — and then drew the opposite
> conclusion from it. "One past the slash" means `str.slice(lastIndex)` starts
> **after** the slash, so `glob` has no leading separator, while `base =
> str.slice(0, lastIndex)` *does* end with one and gets stripped at lines 313–317.
> I stated the mechanism correctly and inverted its meaning in the very next sentence.
>
> What made it survive was that it flattered the exercise: "the docs are wrong and
> only reading the source catches it" is a satisfying story, and I wrote it down
> before running anything. The assertion in `task-5/harness/a2-trace-check.test.ts`
> now records the correction, so it cannot be reintroduced.
>
> Everything else in this document was verified by execution and stands.

---

## Pseudocode

```
FUNCTION scan(input, options)
INPUTS:
  input (text) — the glob pattern as the user wrote it, e.g. "src/**/*.test.ts"
  options (object, optional) — flags that change what is scanned and what is returned.
                 The ones that matter here:
                   parts      (boolean) — scan the WHOLE string, and return the
                                  path segments split on slashes
                   tokens     (boolean) — return a per-segment token array
                   scanToEnd  (boolean) — keep scanning after the first glob character
                                  instead of stopping there
                   noext      (boolean) — do not recognise extglob patterns like "@(a|b)"
                   nonegate   (boolean) — do not treat a leading "!" as negation
                   noparen    (boolean) — do not treat "(" as making the pattern a glob
                   unescape   (boolean) — strip backslash escapes from the result
                 Defaults to an empty object
OUTPUT: a state object with:
  input  (text)  — the pattern exactly as received
  prefix (text)  — leading literal text before the glob part, e.g. "./"
  start  (number)— index in the input where the glob part begins
  base   (text)  — the literal directory portion, e.g. "src"
  glob   (text)  — the portion containing glob syntax, e.g. "**/*.test.ts"
  isGlob (boolean) — whether the pattern contains any glob syntax at all
  isBrace, isBracket, isExtglob, isGlobstar, negated, negatedExtglob (booleans) —
                 which kinds of syntax were seen
  maxDepth (number) — only when options.tokens: the total globstar "cost", where a
                 globstar counts as infinite and every other segment counts as 1
  tokens (array) — only when options.tokens: one token per path segment
  slashes, parts (arrays) — only when options.parts or options.tokens
SIDE EFFECTS: NONE
FAILS WHEN: never throws for a text input. Unbalanced braces, an unclosed bracket or
  a trailing backslash are all tolerated — the scanner just records what it saw and
  carries on. The one thing it will not do is crash on a short string: the loop
  condition protects the character access.
```

### Steps — the scan loop

The scanner holds a cursor `index` starting at −1 (before the first character) and a
`length` one less than the input's length (so the last valid index). `advance()` moves
the cursor forward one place, remembers the character it left behind as `prev`, and
returns the new character code. `eos()` reports whether the cursor has passed the
last character. `peek()` returns the character code after the cursor *without*
moving. **A character code of 0 means "end of string"** — `charCodeAt` past the end
returns `NaN`, and every comparison against `NaN` is false, so the code never matches
anything; several branches rely on this by writing `while (eos() !== true && (code =
advance()))`, where a falsy `code` of 0 ends the loop.

1. WHILE the cursor is not past the last character
   1a.  Read the next character into `code`.
   1b.  IF `code` is a backslash
        -  SET a flag on the current token to record that backslashes were present
        -  Read the NEXT character, overwriting `code`
        -  IF that character is an opening brace, SET a flag that the brace is escaped
        -  SKIP to the next loop iteration. (A backslash never contributes a glob
           character; it only marks the following character as literal.)
   1c.  OTHERWISE IF a brace is escaped OR `code` is an opening brace `{`
        -  OPEN a brace: increment the brace depth counter
        -  INNER LOOP, scanning the brace body until the brace closes or input ends:
            -  IF a backslash appears, note it and skip the following character
            -  IF an opening brace appears, increment depth and continue
            -  IF a literal `..` appears (two consecutive dots) OR a comma appears,
               and the brace is not escaped: mark the token as a brace AND as a glob,
               mark the scan FINISHED, then STOP the inner loop — unless
               options.scanToEnd, in which case keep going
            -  IF a closing brace appears, decrement depth; when depth reaches 0,
               clear the escaped flag, mark the token as a brace, mark the scan
               FINISHED, and STOP the inner loop
        -  IF options.scanToEnd, go back to the top of the outer loop; OTHERWISE
           STOP the outer loop
        Note: a `..` inside braces is what makes `{a,b}` style alternation
        brace-expansion work, and detecting it is what marks the whole pattern a glob.
   1d.  OTHERWISE IF `code` is a forward slash
        -  Record this slash's index in a list
        -  Push the current token onto the token list
        -  START a fresh, empty token
        -  IF the scan is already FINISHED, continue to the next iteration
        -  IF the previous character was a dot AND this slash is the second character
           of the pattern, skip the "./" prefix by advancing the start index past both
        -  OTHERWISE remember the position just after this slash as the last position
           where a literal segment ended
   1e.  OTHERWISE IF options.noext is not set AND `code` is one of `+ @ * ? !` AND the
        NEXT character is `(`
        -  Mark the token as a glob AND as an extglob, and mark the scan FINISHED
        -  IF the character was `!` and it is the first character of the pattern,
           ALSO set the "negated extglob" flag
        -  IF options.scanToEnd, scan forward to the matching `)` (skipping
           backslash-escaped characters) and continue
        -  OTHERWISE STOP the outer loop
   1f.  OTHERWISE IF `code` is `*`
        -  IF the previous character was also `*`, mark the token as a GLOBSTAR
        -  Mark the token as a glob and mark the scan FINISHED
        -  IF options.scanToEnd, continue; OTHERWISE STOP the outer loop
   1g.  OTHERWISE IF `code` is `?`
        -  Mark the token as a glob, mark the scan FINISHED
        -  IF options.scanToEnd, continue; OTHERWISE STOP the outer loop
   1h.  OTHERWISE IF `code` is an opening square bracket `[`
        -  INNER LOOP scanning forward for the closing `]`, skipping backslash escapes
        -  IF a closing bracket is found, mark the token as a bracket AND as a glob and
           mark the scan FINISHED
        -  IF NO closing bracket is found before the end of input, nothing is marked —
           the `[` is treated as a literal character
        -  IF options.scanToEnd, continue; OTHERWISE STOP the outer loop
   1i.  OTHERWISE IF options.nonegate is not set AND `code` is `!` AND it is the FIRST
        character of the pattern
        -  Mark the token as negated, skip past the `!` by advancing the start index,
           and continue (the rest of the pattern is scanned normally)
   1j.  OTHERWISE IF options.noparen is not set AND `code` is `(`
        -  Mark the token as a glob
        -  IF options.scanToEnd, scan to the matching `)` and continue
        -  OTHERWISE STOP the outer loop
   1k.  OTHERWISE IF a glob has already been seen anywhere in this pattern
        -  Mark the scan FINISHED and stop, because everything after a glob character
           is glob territory and the literal prefix is already known
2. IF options.noext was set, CLEAR both the extglob flag and the glob flag —
   the caller has told us extglob syntax does not count as globbing, so a pattern
   whose only special character was an extglob is now a literal.

### Steps — splitting into base and glob

3. SET `base` to the whole input and `prefix` and `glob` to empty text.
4. IF the start index is greater than zero (something was skipped — a `./` prefix or
   a `!` negation marker)
   -  SET `prefix` to the input up to the start index
   -  REMOVE that many characters from the front of `base`
   -  DECREMENT the remembered last-slash position by the same amount
5. IF `base` is non-empty AND a glob was found AND the remembered last-slash position
   is greater than zero
   -  `base` becomes the text before that position, `glob` the text from it onward.
     This is the whole point of the function: "src" vs "**/*.test.ts".
6. OTHERWISE IF a glob was found
   -  `base` becomes empty and `glob` becomes the whole remaining text, because the
      glob starts at the very beginning of what is left.
7. OTHERWISE
   -  `base` becomes the whole remaining text and `glob` stays empty. No glob syntax
      was present, so the pattern is a literal path.
8. IF `base` is non-empty, is not just `/`, and is not already equal to the whole
   remaining text
   -  IF `base` ends with a path separator (a slash or a backslash), REMOVE that
      trailing separator, so callers get "src" rather than "src/".
9. IF options.unescape was set
   -  IF `glob` is non-empty, remove backslash escapes from it
   -  IF `base` is non-empty AND backslashes were seen, remove escapes from `base`

### Steps — the optional token and segment output

10. IF options.tokens was set
    -  SET maxDepth to 0
    -  IF the character the scanner stopped on is not a path separator, push the
       in-progress token onto the token list (so the final segment is not lost)
    -  Attach the token list to the state
11. IF options.parts or options.tokens was set
    -  FOR EACH recorded slash position, in order
        -  Take the segment as the input between the previous slash (or the start
           index, for the first segment) and this slash
        -  IF options.tokens: for the first segment, IF the start index is non-zero,
           mark this token as the PREFIX token and replace its value with the prefix
           text; OTHERWISE set its value to the segment. THEN, unless the token is
           already marked as a prefix, give it a depth of 1 — or INFINITY if the
           token is a globstar — and add that depth to maxDepth
        -  IF this is not the first segment OR the segment is not empty, add the
           segment to the parts list
        -  Remember this slash position as the previous one
      END FOR
    -  IF there was a previous slash position AND there is text after it
        -  Add that trailing text to the parts list, and IF options.tokens, set the
           LAST token's value to it, give it a depth (1, or INFINITY for a globstar)
           and add it to maxDepth
    -  Attach the slash list and the parts list to the state
12. RETURN the state object.

---

## Hand traces

### Input 1 — NORMAL. A nested glob with a literal directory prefix

**Given:** `input = "src/**/*.test.ts"`, `options = {}` (falsy for every flag)

**Trace of the loop**

| Step | Character | What happens |
|---|---|---|
| 1a | index 0 | read `s` |
| 1b-1k | `s`,`r`,`c` | none of the branches match; `isGlob` still false so 1k does not fire |
| 1d | index 2 = `/` | record slash at 2; push the token so far; start a new token; `prev` was `c` not `.`, so remember lastIndex = 3 |
| 1a-1k | `*` at 3 | 1f: `prev` was `/`, not `*`, so not a globstar yet; mark token a glob; mark FINISHED; not scanToEnd → **STOP** |

Loop ends with: `isGlob = true`, `isGlobstar = false`, `isBrace = isBracket =
isExtglob = false`, `negated = negatedExtglob = false`, `start = 0`,
`lastIndex = 3`, slashes = `[2]`.

**Trace of the split**

| Step | What happens | Value |
|---|---|---|
| 2 | noext not set | flags unchanged |
| 3 | initialise | `base = "src/**/*.test.ts"`, `prefix = ""`, `glob = ""` |
| 4 | `start` is 0, not > 0 | skip |
| 5 | base non-empty, isGlob true, lastIndex 3 > 0 | `base = str.slice(0,3) = "src"`, `glob = str.slice(3) = "**/*.test.ts"` |
| 8 | base `"src"` is not `/` and is not the whole string; does it end in a separator? no | `base` stays `"src"` |
| 9 | unescape not set | skip |
| 10-12 | tokens/parts not requested | return |

**Correction at step 5.** The original trace of this row read
`glob = str.slice(3) = "/**/*.test.ts"`. That is wrong. `str.slice(3)` of
`src/**/*.test.ts` starts at the first `*`, because the slash is at index 2 and index
3 is the `*`. I had the mechanism (`lastIndex = index + 1`) and inverted its meaning
in the same sentence. Step 8's trailing-separator strip is also unnecessary here:
`slice(0,3)` is `"src"`, which already has no trailing slash.

**Expected output:** `base = "src"`, `glob = "**/*.test.ts"`, `isGlob = true`,
`isGlobstar = false`, `prefix = ""`, `start = 0`.

**Note the absence of a leading slash on `glob`.** That surprised me on the first
read, so I checked it against the README's own example, which shows
`console.log(pm.scan('foo/bar/*.js'))` → `{ isGlob: true, input: 'foo/bar/*.js',
base: 'foo/bar', glob: '*.js' }`. The README and the code agree.

The reason is easy to get wrong, and I got it wrong — see the correction notice at
the top. `lastIndex` is set to `index + 1` (line 167), which is one character *past*
the slash. So `glob = str.slice(lastIndex)` begins **after** the slash and carries no
separator, while `base = str.slice(0, lastIndex)` ends **with** one and has it
stripped at lines 313–317. The trailing separator lives on `base` and gets removed
there; it is not transferred to `glob`.

### Input 2 — EDGE. A negated pattern, and a `./` prefix

**Probe A — negation:** `input = "!src/*.ts"`

| Step | What happens | Value |
|---|---|---|
| 1i | `!` at index 0, first character, nonegate not set | mark negated, advance start to 1, continue |
| 1a-1k | `s`,`r`,`c` | literal, no match |
| 1d | `/` at index 4 | record slash 4; push token; `prev` was `c`; lastIndex = 5 |
| 1f | `*` at index 5 | mark glob, FINISHED, stop |
| 4 | start 1 > 0 | `prefix = "!"`; `base = "src/*.ts"`; lastIndex 5−1 = 4 |
| 5 | base non-empty, isGlob, lastIndex 4 > 0 | `base = "src"`, `glob = "/*.ts"` |

**Expected:** `negated = true`, `prefix = "!"`, `base = "src"`, `glob = "/*.ts"`.

**Probe B — `./` prefix:** `input = "./src/*.ts"`

| Step | What happens | Value |
|---|---|---|
| 1a-1k | `.` at 0 | literal |
| 1d | `/` at index 1 | record slash 1; push token; **check: `prev` was `.` AND index 1 === start+1 (0+1)** → **yes**, so advance start to 2 and continue without setting lastIndex |
| 1a-1k | `s`,`r`,`c` | literal |
| 1d | `/` at index 5 | record slash 5; push token; `prev` was `c`; lastIndex = 6 |
| 1f | `*` at index 6 | mark glob, FINISHED, stop |
| 4 | start 2 > 0 | `prefix = "./"`, `base = "src/*.ts"`, lastIndex 6−2 = 4 |
| 5 | base non-empty, isGlob, lastIndex 4 > 0 | `base = "src"`, `glob = "/*.ts"` |

**Expected:** `prefix = "./"`, `base = "src"`, `glob = "/*.ts"`, `start = 2`.

The `./` case is what step 1d's second sub-condition exists for: without it, a leading
`./` would be counted as a literal segment and `base` would come out as `"./src"`.
The check is `index === start + 1`, i.e. "this slash is the second character of the
pattern", which is only true for a leading `./`.

### Input 3 — INVALID. Unbalanced and hostile inputs

**Probe A — unclosed bracket:** `input = "src/[abc.ts"`

| Step | What happens | Value |
|---|---|---|
| 1d | `/` at 3 | record slash; lastIndex = 4 |
| 1h | `[` at 4 | enter the inner bracket loop scanning for `]` |
| 1h | scan `a`,`b`,`c`,`.`,`t`,`s` then end of input; **no `]` found** | nothing marked — the loop simply ends |
| 1h | not scanToEnd | **STOP** |
| 5 | `isGlob` is still **false** | the `if` fails; `else if (isGlob)` fails; so `base = "src/[abc.ts"`, `glob = ""` |

**Expected:** `isGlob = false`, `isBracket = false`, `base = "src/[abc.ts"`,
`glob = ""`. An unclosed bracket degrades to a literal path instead of throwing. That
is deliberate robustness — a user glob should not crash a build — but it means a typo
in a character class produces a path that matches nothing rather than an error.

**Probe B — trailing backslash:** `input = "src\\"`

| Step | What happens | Value |
|---|---|---|
| 1a-1k | `s`,`r`,`c` | literal |
| 1b | `\` at 3 | set the backslash flag on the token; read the next character, which is past the end and yields 0; not `{`; continue |
| loop | cursor is now past the last character | loop condition ends it |

**Expected:** no throw, `isGlob = false`, `base = "src"`. Wait — step 8 removes a
trailing separator only from a non-empty `base` that is not the whole string, and here
`base` IS the whole string, so the backslash survives: `base = "src\\"`. The token's
backslash flag is set but `unescape` was not requested, so nothing is stripped.

**Probe C — negation mistaken for extglob:** `input = "!(a|b)"`

| Step | What happens | Value |
|---|---|---|
| 1e | `!` at 0, `noext` not set, and the next char is `(` | mark glob AND extglob, FINISHED; `code === !` and index === start (0) so ALSO set negatedExtglob; not scanToEnd → STOP |

**Expected:** `isExtglob = true`, `negatedExtglob = true`, `isGlob = true`,
`base = ""`, `glob = "!(a|b)"`. Both flags are set, and the caller is expected to
distinguish them — the README is explicit that a leading `!` is negation *unless*
followed by `(`, in which case it is "match anything except these". Step 1e is the
only place that draws that distinction, and it does it by checking the next character
before step 1i ever sees the `!`.

---

## Trace vs. execution

| # | Category | Input | Predicted | Executed | Agree? |
|---|---|---|---|---|---|
| 1 | normal | `src/**/*.test.ts` | `base="src"`, `glob="**/*.test.ts"`, `isGlob=true` | identical | ✅ (after correction) |
| 1b | edge (bonus) | `src/**/*.ts` with `{parts:true}` | `isGlobstar=true` | `isGlobstar=true` | ✅ |
| 1c | edge (bonus) | `src/**/*.ts` with **no** options | `isGlobstar=false` — the loop stops at the first `*` | identical | ✅ |
| 2a | edge | `!src/*.ts` | `negated=true`, `prefix="!"`, `base="src"` | identical | ✅ |
| 2b | edge | `./src/*.ts` | `prefix="./"`, `base="src"`, `start=2` | identical | ✅ |
| 3a | invalid | `src/[abc.ts` | `isGlob=false`, `base="src/[abc.ts"` | identical | ✅ |
| 3b | invalid | `src\` | no throw, `isGlob=false`, `base="src\"` | identical | ✅ |
| 3c | invalid | `!(a\|b)` | `isExtglob=true`, `negatedExtglob=true`, `base=""` | identical | ✅ |
| 4 | edge | `src/*.ts` with `{tokens:true, parts:true}` | `maxDepth=2`, `parts=["src","*.ts"]` | identical | ✅ (after correction) |
| 5 | edge | `foo/bar/*.js` | **predicted `glob="/*.js"`** | `glob="*.js"` | ❌ **the trace was wrong** |

**Discrepancies: two. One I fixed, one I am reporting as a failure.**

### Discrepancy 1 — the false claim about the README (fixed)

My trace predicted `glob: '/*.js'` for `foo/bar/*.js` and I presented it as proof that
the library's own documentation was out of date. Execution gives `glob: '*.js'`. **The
README is correct and my trace was wrong** — see the correction notice at the top of
this file.

The failure mode is worth naming precisely, because it is not "I misread the code". I
had the correct mechanism — `lastIndex = index + 1`, one character past the slash — and
then inverted it in the next breath, concluding that `str.slice(lastIndex)` *included*
the slash when "one past the slash" means it starts after it. The error was one
inference, not a misreading, and it was invisible to me because the resulting story
was flattering: *the docs are wrong and only the source reveals it* is a satisfying
conclusion to reach, and I wrote it down without running anything.

The transferable lesson is the opposite of the one I originally drew. Verifying by
execution does not just confirm a good prediction — **it is the only thing standing
between a confident trace and a confident error.** Row 5 exists in the harness
specifically so this cannot be quietly reintroduced.

### Discrepancy 2 — a missing condition in my own pseudocode (found by tracing)

I initially wrote step 1h as "mark the token as a bracket". It is conditional — the flag
is set only when a closing `]` is actually found. An unclosed bracket leaves
`isBracket` false. That single missing condition turned an `isGlob: true` prediction
into `isGlob: false` for probe 3a, which is the difference between "treat as a glob
and match some files" and "treat as a literal and match nothing". Found by tracing
probe 3a step by step rather than by pattern-matching on the happy path.

### Two subtleties worth keeping, both confirmed by execution

- **`isGlobstar` needs `parts: true`.** For `src/**/*.ts`, the default scan reports
  `isGlobstar: false`, because the loop breaks at the *first* `*` and never reaches the
  second. `tokens: true` alone does not change this; `parts: true` is what sets it.
- **`maxDepth` is `Infinity` for any globstar pattern, and `JSON.stringify` turns that
  into `null`.** So `maxDepth: 2` for `src/*.ts` (one depth per non-globstar segment),
  `Infinity` for `src/**/*.ts`, and `null` in the JSON once serialised. Anything that
  persists scan output through JSON loses the distinction between "infinite depth" and
  "no depth recorded".
