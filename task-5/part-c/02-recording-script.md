# Part C4 — 5-Minute Explanation Script & Listener Feedback

> **Submission Guide:**
> This document contains the speaking script and listener feedback questionnaire for Step C4.
> 1. Use the script in §2 to record a 5-minute explanation of the discount system and validation ordering to a non-technical friend or colleague.
> 2. Ask them the 6 questions in §3 and record their verbatim answers in §4.
> 3. Save the recording to `task-5/evidence/part-c4-recording.*`.

---

## 1. Before you record

| Requirement | Detail |
|---|---|
| **Audience** | Someone who does not write software. A manager, a friend, a family member. Not a colleague who reviews code. |
| **Length** | 5–8 minutes. Long enough to be honest, short enough that they will actually sit through it. |
| **Recording** | Phone voice memo is fine. Screen-share is fine. What matters is that a human voice is on the recording. |
| **Consent** | Ask first, and say what it is for: evidence that you can explain your own decisions. Offer to delete it. |
| **Preparation** | Read the script below once. Do not rehearse it verbatim — you will sound like a document being read, which is the thing this step is testing. |

**What this step is actually checking.** Not whether you can define "idempotency". It
is checking whether you built a model of *why* the ordering of two checks matters,
because that is the one idea in this task that is not self-evident. If the listener
cannot follow that, the model is not built yet.

---

## 2. The script

### Opening — 30 seconds

> "I've been working on a payment system — it's the part of an app where people pay
> for a subscription, and it handles upgrades and discount codes. I want to explain
> what I built and, more importantly, one decision I got wrong the first time. I'll
> talk for about six minutes and I really do want to know where I lose you — that's
> the useful part."

### Part one — what the thing does — 90 seconds

> "The basic job: someone is on a £5,000-a-year plan, they upgrade, and they should
> only pay the difference. Not the whole new price — that's the point.
>
> "There's also a discount code system. You type a code, it takes a percentage off, and
> a code can have rules: it expires on a certain date, it only works if you spend
> enough, and each person can only use it once."

> **If asked "why does the percentage matter so much?"** — because all the money in
> this system is stored as whole numbers of the smallest unit, like cents. No
> decimals. A quarter of a percent of an odd number isn't a whole number, so the
> system has to decide when to round, and getting that wrong means the books don't
> add up.

### Part two — the decision I got wrong — 2 minutes

**This is the part that matters. Spend the time here.**

> "When a customer applies a discount code, my code checks things in a specific order.
> Five checks: does this code exist, is the percentage it stores a sane value, is it
> still in date, is the customer spending enough, and has this customer used it
> before.
>
> "I put the 'is it still in date' check second. My own written specification said to
> put a different check before it — the one that verifies the stored percentage is
> sane. I didn't follow my own spec. The code ran, the tests passed, and it was still
> wrong.
>
> "Here's why that matters. The percentage check is a kind of canary: if a code in the
> database has a nonsense percentage, that's a bug in *how the code was created*, not
> something the customer did. It should be loud — it should tell us to go fix
> something.
>
> "But I'd put the date check in front of it. So if the code was both nonsense *and*
> expired, the customer got told 'this code has expired'. Which sounds completely
> reasonable. Except it hides the real problem. If that code had been valid and
> active, the customer would have gotten an absurd discount, and nobody would have
> noticed for weeks. I'd turned a loud bug into a quiet one."

> **If asked "so how did you find it?"** — the honest answer: I built a second,
> independent version of the same thing to compare against, and it happened to check
> in the other order. If asked about that: yes, that's a bit of a fluke; a different
> pair of attempts might not have caught it. The other answer is: I should have written
> a test that failed either way, and I didn't — the tests I had passed for the wrong
> reason.

### Part three — what I'd do differently — 60 seconds

> "Two things.
>
> "One: don't argue for something in a paragraph. Put it in the list of steps where it
> can't be skipped. I wrote a careful explanation of why the order mattered, and then
> wrote the code a different way. The explanation didn't help because it wasn't where
> the decision gets made.
>
> "Two: a test that passes for the wrong reason is worse than no test. My test checked
> 'does a broken percentage get rejected' — and it passed, because the code was also
> expired, so it got rejected for a different reason. It looked like coverage. It
> wasn't."

### Part four — open floor — 60 seconds

> "That's the whole thing. Ask me anything — genuinely, I want to find out where this
> got too detailed or where I was vague."

---

## 3. Questions to ask the listener afterwards

Ask these **after** the recording, and write their answers down verbatim. Do not
paraphrase them into something more articulate — the value is in how they actually
phrased it.

1. In your own words, what does this system do?
2. What was the mistake I made, and why was it a problem?
3. What did "passing for the wrong reason" mean, in your view?
4. Did any part feel unclear? Which part?
5. Was there a moment where you lost track of what I was talking about?
6. Anything you'd want to see differently?

**Question 4 and 5 are the ones that matter.** A listener who says "I followed all of
it" is being polite. Ask question 5 directly and give them permission — "if you got
lost at any point, I want to know where, because that's the useful bit for me."

---

## 4. The listener's note — blank form

Fill this in after they have watched. **Write what they said, not what you wish they
had said.**

---

> **Listener's name:**
>
> **Their relationship to the work** (e.g. "my manager", "friend, no technical
> background"):
>
> **Length of the recording:**
>
> ---
>
> **In their words, what did I explain?** *(transcribe, do not summarise)*
>
> > 
>
> ---
>
> **Where did they say they got lost, or ask me to slow down?** *(verbatim, or "they
> said they followed it throughout")*
>
> >
>
> ---
>
> **Did anything I said seem wrong or surprising to them?**
>
> >
>
> ---
>
> **Anything they asked that I could not answer?**
>
> >
>
> ---
>
> **Their overall reaction, in one sentence:**
>
> >
>
> ---

---

## 5. Completing This Step

1. Record your 5-minute talk using the script in §2. Save the audio/video to `task-5/evidence/part-c4-recording.*`.
2. Ask your listener the 6 questions in §3. Write their answers down verbatim in §4.
3. Fill in the date, listener name, and file link in the form above.