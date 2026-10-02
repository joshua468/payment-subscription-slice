# Task 5 — Pseudocoding & Verification

This repository contains my complete submission for Task 5 of the Product Engineering Bootcamp.

The goal of this task is to prove deep understanding of code independently of tools or AI assistants by reading code into pseudocode, writing code from strict pseudocode specifications, and directing AI agents with exact pseudocode to verify and compare what they produce.

All pseudocode, hand traces, and implementation comparisons in this repository are backed by an executable test harness:

```bash
node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
```
**Result:** 5 test files, 117 tests passing.

---

## The Pseudocode Standard

All pseudocode in this project strictly follows the bootcamp standard:

```text
FUNCTION name
INPUTS:        each input, its type, and what it means
OUTPUT:        what is returned, with its type
SIDE EFFECTS:  anything written, sent or changed outside the function, or NONE
FAILS WHEN:    every condition under which it cannot succeed
```

### Formatting Rules:
1. **Numbered steps:** One clear action per step, written in plain English, present tense.
2. **Explicit branches:** `IF`, `OTHERWISE`, `RETURN`.
3. **Explicit loops:** Clear indication of what is being iterated and when the loop stops.
4. **Marked side effects & calls:** External operations marked with `CALL`, database/state changes marked with `WRITE`.
5. **Predictability:** Anyone reading only the pseudocode should be able to predict the exact output for any input, including edge cases.

---

## Directory Structure & Contents

| Section | Directory | What is included |
| :--- | :--- | :--- |
| **Part A1: Own Functions** | `part-a/a1-own/` | 3 functions from this codebase (`fulfilFromWebhook`, `calculateProration`, `verifyWebhookSignature`). Includes pseudocode, hand traces (normal, edge, invalid), and verified outputs. |
| **Part A2: Open Source** | `part-a/a2-opensource/` | 3 open-source functions (`ms`, `fast-deep-equal`, `picomatch.scan`). Manual pseudocode, hand traces, and comparison against AI explanations (finding 7 AI mistakes). |
| **Part A3: Planted Bug** | `part-a/a3-planted-bug/` | A proration function with a planted bug. Analyzed using the two-pseudocode method (actual behavior vs. intended behavior) to isolate and fix the defect. |
| **Part B: Human Implementation** | `part-b/` | A new discount redemption engine. Fully specified in pseudocode first, hand-traced with 5 complex inputs, then implemented in clean TypeScript (`discount.ts`). |
| **Part C: AI Verification & Comparison** | `part-c/` | The same pseudocode handed to an AI agent (`discount-ai.ts`), reverse-engineered back into pseudocode, compared in a difference table, verified across 10 test scenarios, plus an explanation script. |
| **Test Harness** | `harness/` | 117 automated unit tests checking all hand traces, edge cases, and comparisons. |
| **Evidence** | `evidence/` | Index of all verifiable claims, test runs, and recording artifacts. |

---

## Key Findings & What I Learned

### 1. AI explanations can sound convincing while being factually wrong (Part A2)
When I compared my manual code traces against what an AI explained from general knowledge:
- The AI claimed `ms('invalid')` throws an error; in reality, it silently returns `undefined`.
- The AI claimed `fast-deep-equal` compares `Set` members deeply; in reality, it uses identity comparison (`Set.has`).
- The AI claimed `picomatch.scan` throws on malformed globs; in reality, it tolerates them and degrades to a literal string.

**Takeaway:** Reading source code directly and writing down step-by-step pseudocode catches critical edge cases that AI summaries miss.

### 2. The Two-Pseudocode method catches subtle bugs immediately (Part A3)
By writing one pseudocode block for what the buggy code *actually did* and another for what it *should do*, the discrepancy stood out plainly:
- An intermediate daily rate was being rounded to whole cents before multiplying by remaining days, introducing compounding rounding errors.
- Out-of-bounds days were being silently clamped instead of throwing a clean validation error.

### 3. Clear specifications prevent AI hallucination (Part B & C)
When given a vague prompt like "create a discount feature," AI often adds unneeded features or makes incorrect assumptions about rounding and ordering. 
When given strict, numbered pseudocode, the AI implementation (`discount-ai.ts`) matched my human implementation (`discount.ts`) across all 10 test scenarios.

### 4. Validation order matters (Part C Difference Table)
Comparing my implementation against the AI implementation revealed a subtle bug in my own code:
- My initial code checked the expiration date *before* validating the stored discount percentage.
- The AI (following the strict requirements) validated the discount percentage first.
- If a code was both expired and had an invalid percentage (e.g. 150%), checking the expiration date first would return "Code Expired" (masking the critical database configuration error) instead of alerting the team to an invalid discount value.
- Catching this taught me that test cases must test edge cases independently rather than combining multiple invalid states.

---

## Running the Tests

To run the complete Task 5 verification test suite:

```bash
npm test
# Or run the Task 5 harness specifically:
node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
```