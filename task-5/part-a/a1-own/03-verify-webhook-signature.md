# A1.3 — `verifyWebhookSignature`

**Source:** `lib/payment/flutterwave.ts:86-118`
**Why this one:** this is the authorisation boundary. Everything downstream —
entitlement, the payment log, the dispute defence — is only as trustworthy as this
function's answer. It also happens to be an error-handling function: its entire job
is deciding whether something is wrong, and it has a failure mode that is easy to
miss (it throws before it ever looks at a signature).

---

## Pseudocode

```
FUNCTION verifyWebhookSignature
INPUTS:
  rawBody (text) — the exact bytes of the request body, captured BEFORE any parsing.
                 Signature verification happens on these bytes, not on a re-serialised
                 object, because re-serialising changes byte order and key spacing and
                 would produce a different digest
  flutterwaveSignature (text or null) — value of the current `flutterwave-signature`
                 header, which carries a base64 HMAC digest. Null when absent
  verifHash (text or null) — value of the legacy `verif-hash` header, which carries the
                 secret itself for direct comparison. Null when absent
OUTPUT: boolean — true only when the request is authentic. False means reject with 401
                 and do not read the payload
SIDE EFFECTS:
  - READS environment variables (PAYMENT_MODE, FLUTTERWAVE_SECRET_KEY,
    FLUTTERWAVE_PUBLIC_KEY, FLUTTERWAVE_WEBHOOK_SECRET)
  - performs a constant-time byte comparison
  - none of these are writes; the function is otherwise pure with respect to the database
FAILS WHEN:
  - PAYMENT_MODE is neither "test" nor "prod" — THROWS PaymentError INVALID_PAYMENT_MODE
  - a required credential is missing — THROWS PaymentError MISSING_CREDENTIALS
  - test mode is set but a credential is not a test key, or prod mode is set but a
    credential IS a test key — THROWS PaymentError CREDENTIAL_MODE_MISMATCH
  Note that every one of those throws happens in step 1, BEFORE any signature is
  examined. A misconfigured deployment therefore rejects every webhook with a thrown
  error rather than answering 401. That is deliberate: a config error is an
  operational fault the operator must see, not a 401 to be silently absorbed.
```

### Steps

1. READ the payment configuration from the environment. This validates the mode and
   the credential prefixes. It may THROW; if it throws, the exception leaves this
   function immediately and no signature is examined.
2. SET `webhookSecret` to `FLUTTERWAVE_WEBHOOK_SECRET` when that variable is set to
   a non-empty value, OTHERWISE to the configured Flutterwave secret key.
3. IF `flutterwaveSignature` is present and non-empty
   3a. CALCULATE `expected` as the base64 encoding of the HMAC-SHA256 of `rawBody`,
        keyed with `webhookSecret`, interpreting `rawBody` as UTF-8.
   3b. IF `expected` and `flutterwaveSignature` have the same byte length AND every
        corresponding byte is equal, compared in constant time
       RETURN true.
   OTHERWISE fall through to step 4. (A wrong signature does not end the function;
   it just means this mechanism did not authenticate the request.)
4. IF `verifHash` is present and non-empty
   4a. IF `webhookSecret` and `verifHash` have the same byte length AND every
        corresponding byte is equal, compared in constant time
       RETURN true.
5. RETURN false.
```

---

## Hand traces

Fixed values for every trace:
- `PAYMENT_MODE = "test"`
- `FLUTTERWAVE_SECRET_KEY = "FLWSECK_TEST-dummy-secret"`
- `FLUTTERWAVE_PUBLIC_KEY = "FLWPUBK_TEST-dummy-public"`
- `FLUTTERWAVE_WEBHOOK_SECRET` unset, so `webhookSecret = "FLWSECK_TEST-dummy-secret"`
- `rawBody = '{"event":"charge.completed","data":{"id":"tx-1"}}'`
- `correctDigest` = base64(HMAC-SHA256(rawBody, "FLWSECK_TEST-dummy-secret"))

Every trace is reproduced against real execution, with the real digest computed by
Node's own `crypto`, in `task-5/harness/a1-trace-check.test.ts`.

### Input 1 — NORMAL. Correct current-mechanism signature

**Given:** `flutterwaveSignature = correctDigest`, `verifHash = null`

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | read config; mode is `test`, both keys start with the test prefix | config valid, no throw |
| 2 | `FLUTTERWAVE_WEBHOOK_SECRET` unset | `webhookSecret = "FLWSECK_TEST-dummy-secret"` |
| 3 | `flutterwaveSignature` present and non-empty | enter branch |
| 3a | HMAC-SHA256 of the body, base64 | `expected = correctDigest` |
| 3b | lengths equal (both 44 bytes) and all bytes equal | **RETURN true** |

**Expected output:** `true`. The webhook route continues to parse the payload.

### Input 2 — EDGE. Legacy header only, correct value

**Given:** `flutterwaveSignature = null`, `verifHash = "FLWSECK_TEST-dummy-secret"`

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | config valid | — |
| 2 | as above | `webhookSecret = "FLWSECK_TEST-dummy-secret"` |
| 3 | `flutterwaveSignature` is null → branch not taken | fall through |
| 4 | `verifHash` present and non-empty | enter branch |
| 4a | secret and `verifHash` are the same 27-byte string, all bytes equal | **RETURN true** |

**Expected output:** `true`.

### Input 3 — ADVERSARIAL. Correct legacy header, forged current header

**Given:** `flutterwaveSignature = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"`
(a well-formed 44-character base64 string that is simply wrong),
`verifHash = "FLWSECK_TEST-dummy-secret"`

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | config valid | — |
| 2 | `webhookSecret = "FLWSECK_TEST-dummy-secret"` | — |
| 3 | `flutterwaveSignature` present | enter branch |
| 3a | compute the real digest | `expected = correctDigest` |
| 3b | lengths are equal (44 = 44) but bytes differ | comparison is false, **fall through** |
| 4 | `verifHash` present | enter branch |
| 4a | secret equals `verifHash` byte for byte | **RETURN true** |

**Expected output:** `true`.

**This is the finding.** The two mechanisms are combined with OR, not with
precedence. A request that carries a *forged* `flutterwave-signature` is still
accepted as long as it also carries a valid `verif-hash` — and `verif-hash` is, by
Flutterwave's legacy design, the secret itself. So in a deployment that still accepts
the legacy header, presenting the secret in a request header is sufficient to forge
any payment event. The HMAC mechanism does not defend against that, because the HMAC
check is not required to pass.

The signature verification is therefore only as strong as the *weakest accepted
mechanism*, and accepting both mechanisms means the legacy one — which is a shared
secret compared directly, replayable forever — sets the strength for everyone.
Resolving this is not a one-line change (dropping `verif-hash` breaks any provider
still sending it), which is why it belongs in a review comment with a migration plan,
not in a silent edit.

### Input 4 — INVALID. No signature headers at all

**Given:** `flutterwaveSignature = null`, `verifHash = null`

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | config valid | — |
| 2 | `webhookSecret` set | — |
| 3 | `flutterwaveSignature` is null → branch not taken | fall through |
| 4 | `verifHash` is null → branch not taken | fall through |
| 5 | nothing authenticated the request | **RETURN false** |

**Expected output:** `false` → the route returns **401** with no payload read.

### Input 5 — EDGE. Correct digest, wrong body (tampering)

**Given:** the same `correctDigest` as Input 1, but `rawBody` has been altered to
`'{"event":"charge.completed","data":{"id":"tx-999"}}'` (the amount or the tx_ref
attacker-changed)

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1-2 | as before | `webhookSecret` set |
| 3 | `flutterwaveSignature` present | enter branch |
| 3a | HMAC over the *tampered* body | `expected ≠ correctDigest` |
| 3b | lengths equal, bytes differ | fall through |
| 4 | `verifHash` null → not taken | fall through |
| 5 | nothing authenticated | **RETURN false** |

**Expected output:** `false`. The digest is bound to the exact bytes, so changing one
character invalidates it. This is why step 1 of the webhook route captures
`await request.text()` and passes that same string onward, rather than parsing first
and re-serialising.

### Input 6 — ADVERSARIAL. Misconfigured credentials (prod mode, test keys)

**Given:** `PAYMENT_MODE = "prod"`, but `FLUTTERWAVE_SECRET_KEY` still begins
`FLWSECK_TEST-`

**Trace**

| Step | What happens | Value after |
|---|---|---|
| 1 | mode is `"prod"`, so it is a legal value | pass that check |
| 1 | secret begins with the test prefix | **THROW PaymentError CREDENTIAL_MODE_MISMATCH** |

**Expected output:** a thrown `PaymentError` with code `CREDENTIAL_MODE_MISMATCH`. The
signature is never examined. The webhook route does not catch this, so it surfaces as
a 500, not a 401 — which is the intended signal: "this deployment is misconfigured",
not "this request is forged".

---

## Trace vs. execution

| # | Category | Predicted | Executed | Agree? |
|---|---|---|---|---|
| 1 | normal | `true` | `true` | ✅ |
| 2 | edge (legacy only) | `true` | `true` | ✅ |
| 3 | adversarial (forged HMAC + valid legacy) | `true` | `true` | ✅ |
| 4 | invalid (no headers) | `false` | `false` | ✅ |
| 5 | edge (tampered body) | `false` | `false` | ✅ |
| 6 | adversarial (prod mode, test keys) | throws `CREDENTIAL_MODE_MISMATCH` | same | ✅ |

**Discrepancies found and corrected: two, both in my first draft.**

1. My first draft of step 3b said "compare in constant time, and if the comparison
   throws, treat it as invalid." I had assumed the length check was implicit in the
   constant-time compare. Reading the code, the length check is a **separate, explicit
   guard that runs first** (`a.length === b.length && timingSafeEqual(a, b)`), and it
   is load bearing: `timingSafeEqual` throws a `RangeError` when the two buffers
   differ in length, so without the guard a wrong-length signature would produce a
   500 instead of a clean `false`. The guard is also the one place where timing does
   leak — the *length* of a candidate signature is compared in non-constant time. That
   is an acceptable trade (length is not the secret; content is) but it is a real
   property of the code, and the pseudocode now says so.

2. My first draft of the header block implied the legacy mechanism was a fallback used
   only when the modern one was absent. Input 3 forced me to check the control flow
   properly: the modern branch **falls through** on failure rather than returning
   `false`, so the legacy branch is consulted regardless of what the modern branch
   found. That is the bug in Input 3, and I would not have found it by reading the
   function top-to-bottom — I found it by asking "what happens if a request supplies
   *both* headers, one right and one wrong?" and then tracing that specific input.

**A note on the constant-time comparison, since it is the kind of detail that gets
cargo-culted.** `timingSafeEqual` is only constant time for inputs of equal length.
The code gets this right by checking length first, but it means "we use
`timingSafeEqual`" is not by itself a security property — it is only a security
property in combination with a correct length guard and a canonical encoding on both
sides. The encoding matters too: the digest is produced as **base64** and compared as
base64, not as hex. Comparing hex to base64 would fail every time while still looking
like a correct implementation.
