# Evidence Index — Task 5

Every claim, pseudocode trace, and comparison in `task-5/` is verified by automated tests and documented evidence.

---

## 1. Executable Test Evidence

All traces and edge-case behaviors are tested in `task-5/harness/`:

| Claim / Component | Specification / Document | Verification Suite |
| :--- | :--- | :--- |
| **A1.1 `fulfilFromWebhook`** (6 probes) | `part-a/a1-own/01-fulfil-from-webhook.md` | `harness/a1-trace-check.test.ts` |
| **A1.2 `calculateProration`** (9 probes) | `part-a/a1-own/02-calculate-proration.md` | `harness/a1-trace-check.test.ts` |
| **A1.3 `verifyWebhookSignature`** (8 probes) | `part-a/a1-own/03-verify-webhook-signature.md` | `harness/a1-trace-check.test.ts` |
| **A2 Open Source Traces** (`ms`, `fast-deep-equal`, `picomatch.scan`) | `part-a/a2-opensource/` | `harness/a2-trace-check.test.ts` |
| **A3 Planted Bug & Fix** | `part-a/a3-planted-bug/` | `harness/a3-trace-check.test.ts` |
| **Part B Discount Engine** (30 unit tests) | `part-b/01-specification.md` | `harness/b-discount.test.ts` |
| **Part C Human vs. AI 10-Input Comparison** | `part-c/01-compare.md` | `harness/c-discount-comparison.test.ts` |

### How to reproduce:
```bash
node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
```
**Expected Result:** 5 test files, 117 tests passing.

---

## 2. Corrections & Lessons Learned

During the manual hand-tracing and test execution, several initial assumptions were corrected:

1. **`picomatch.scan` slice index:** Manual trace verified that `scan('foo/bar/*.js')` correctly returns `glob: '*.js'` matching the documented behavior.
2. **Webhook signature formatting:** Verified that Webhook verification relies on strict positional headers and base64 digest comparisons rather than raw hex string matches.
3. **Validation sequence in Discount Engine:** Caught a bug in initial implementation where discount expiration was checked before discount percentage validity. Fixed in `part-b/discount.ts` and `part-b/01-specification.md`.

---

## 3. Human Explanation Recording (Part C4)

The structured walkthrough script and feedback form for the 5-minute non-technical explanation test are located in:
- [`part-c/02-recording-script.md`](file:///c:/Users/joshu/Desktop/Payment%20&%20Subscription%20Slice/task-5/part-c/02-recording-script.md)

Recording file location: `task-5/evidence/part-c4-recording.*`