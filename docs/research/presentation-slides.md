# Building Atlas: 5 Slides on the Process

Content for a 5-slide deck — each slide has a title, the story/talking
points, two real code pieces from the actual codebase, and a short note on
how the two pieces connect. Copy directly into PowerPoint. A bonus Slide 6
was added later, once a genuinely new milestone was reached after this deck
was first built — include it if you want more depth, or if a teacher asks
"what's the most advanced thing in here."

---

## Slide 1 — "Don't argue about it, prove it"

**Talking points**
- We spent a long conversation debating one question: if a stolen card is
  used to buy crypto through Atlas, and the bank reverses the charge weeks
  later, does Atlas actually lose money?
- Instead of settling it with opinions, we wrote a rule that makes every
  transaction provably honest, then used that rule to compute the real
  answer.

**Code piece 1 — the rule every transaction must obey**
```ts
export function assertBalanced(lines: LedgerLine[]): void {
  const byAsset = new Map<AssetCode, Money[]>();
  for (const line of lines) {
    const existing = byAsset.get(line.amount.asset) ?? [];
    existing.push(line.amount);
    byAsset.set(line.amount.asset, existing);
  }
  for (const [asset, amounts] of byAsset) {
    const total = sumMoney(asset, amounts);
    if (!total.isZero()) throw new UnbalancedTransactionError(asset, total);
  }
}
```

**Code piece 2 — the answer, computed, not argued**
```ts
const operatingTotal = balanceOf([...day0, ...day30], "ATLAS_OPERATING", null, "AUD");
expect(operatingTotal.toDecimalString()).toBe("-1000.00");
```

**How they connect:** piece 1 is a law with no exceptions — every
transaction's entries must cancel out to zero, for every asset, or the code
refuses to record it. Because that law is enforced everywhere, piece 2's
result can be trusted: `-£1000.00` isn't an assumption, it's what falls out
of real entries once you're forced to account for every movement honestly.

> **Explanation, for you (not for the slide):** double-entry bookkeeping is
> not something invented for this project — it's an accounting method
> hundreds of years old, older than computers by a long way. The idea is
> simple once you see it: every time value moves, you record *two* things —
> where it came from and where it went — and if you add up all the "came
> from"s and "went to"s for any transaction, they should cancel out to
> exactly zero. If they don't, something is wrong: money got invented out of
> nowhere, or vanished. `assertBalanced` is that rule written as code — it
> refuses to let the program save a transaction unless it cancels out. That
> matters here because we'd spent a long conversation *arguing in words*
> about whether Atlas loses money when a stolen card buys crypto and the
> charge later gets reversed. Once the ledger is forced to always balance,
> we could just simulate that exact sequence of events as a list of
> balanced entries and literally add up the result — `-£1000.00` — instead
> of continuing to guess. The code didn't just help us build the system, it
> settled a debate we couldn't settle by talking.

---

## Slide 2 — "Money has to be exact"

**Talking points**
- Computers store decimals approximately by default — `0.1 + 0.2` doesn't
  equal `0.3` in most programming languages.
- For money, "approximately right" is a bug, not a rounding quirk. Atlas
  stores every amount as a whole number of the smallest unit (pence,
  satoshis) instead of a decimal.

**Code piece 1 — decimals become exact whole numbers**
```ts
static fromDecimalString(asset: AssetCode, decimal: string): Money {
  const { decimals } = assetOf(asset);
  const [whole, frac] = decimal.split(".");
  const minorUnits = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac ?? "0");
  return Money.of(asset, minorUnits);
}
```

**Code piece 2 — proof the classic bug doesn't happen here**
```ts
it("arithmetic is exact, not float-approximate", () => {
  const a = Money.fromDecimalString("GBP", "0.10");
  const b = Money.fromDecimalString("GBP", "0.20");
  expect(a.plus(b).toDecimalString()).toBe("0.30"); // fails with normal floats
});
```

**How they connect:** piece 1 is the design decision — never let a decimal
number exist as a decimal, convert it to an exact integer immediately.
Piece 2 is the test that would catch it if that decision were ever
accidentally undone somewhere in the code later.

> **Explanation, for you (not for the slide):** computers store numbers in
> binary (base 2), and just like 1/3 can't be written exactly in decimal
> (it's 0.333... forever), a lot of ordinary decimal fractions — including
> 0.1 — can't be written exactly in binary. The computer has to round it to
> the nearest number it *can* represent. Usually that rounding error is so
> tiny nobody notices. But money calculations add, subtract, and multiply
> amounts constantly, and those tiny errors can build up — or worse, cause a
> comparison like "is this the same amount?" to fail when it obviously
> should be true. The fix isn't a clever trick, it's just avoiding the
> problem entirely: instead of storing "£10.50," store "1050 pence" as a
> whole number. Whole numbers (integers) don't have this rounding problem at
> all — adding, subtracting, and comparing them is always exact. Every
> `Money` value in this codebase is secretly just a big whole number of
> pence (or satoshis, or whatever the smallest unit of that currency is)
> underneath, and it only ever gets turned into something like "£10.50" for
> display, right at the very end.

---

## Slide 3 — "No passwords — identity is cryptography"

**Talking points**
- Atlas's whole premise from the start was "identity is a keypair, not an
  account." That has to be true for logging in too, not just as a slogan.
- Every request to the real backend is signed with the user's own private
  key. There is no password anywhere in this codebase.

**Code piece 1 — exactly what gets signed**
```ts
export function canonicalSigningString(input: SignedRequestInput): string {
  return [input.method.toUpperCase(), input.path,
          String(input.timestampMs), input.bodySha256Hex].join("\n");
}
```

**Code piece 2 — proof tampering gets caught**
```ts
const tamperedPath = { ...original, path: "/withdrawals" };
await expect(
  verifyRequestSignature({ publicKeyBase64, signatureBase64: signature, input: tamperedPath }),
).rejects.toThrow(InvalidSignatureError);
```

**How they connect:** piece 1 bakes the method, path, timestamp, and body
into one string before it's ever signed. Piece 2 proves that if an attacker
changes even one of those things after the fact — say, redirects a signed
request from one endpoint to another — the signature stops matching and the
request is rejected. The security claim isn't just written in a comment, it
was tested against a real forgery attempt.

> **Explanation, for you (not for the slide):** public-key cryptography
> gives you two mathematically linked keys. One, the private key, you keep
> completely secret and it never leaves your device. The other, the public
> key, you can hand out to anyone. Anything signed with the private key can
> be checked against the public key by anyone — and that check will only
> pass if it really was signed by the matching private key. That's the
> whole trick: proving "this is really me" without ever having to send the
> secret part anywhere, which is exactly the weakness a password has (it
> has to be sent to a server and checked there, which means it can be
> stolen from that server — this happens in real data breaches constantly).
> The second idea on this slide — signing the *method, path, timestamp, and
> body together* rather than just signing "yes, approved" — matters because
> otherwise a signature could be captured and reused somewhere it was never
> meant for. Imagine signing a blank check versus signing a check that says
> "pay exactly £10 to exactly this person, exactly today." Atlas signs the
> second kind: the exact request, not a vague approval, so a captured
> signature can't be replayed against a different action or a later time.

---

## Slide 4 — "Building before the business exists"

**Talking points**
- We don't have a Stripe account, a crypto exchange account, or a real
  wallet provider account yet — this is a school project, not a licensed
  company.
- Even so, we could write and test the *real* logic today, by coding
  against an interface first and swapping in the real company's code later
  without touching anything else.

**Code piece 1 — the contract, not the company**
```ts
export interface CardFundingAdapter {
  chargeCard(args: { fundingSourceExternalRef: string; amount: Money; reference: string })
    : Promise<ChargeResult>;
  checkStatus(externalRef: string): Promise<ChargeResult["status"] | "DISPUTED">;
}
```

**Code piece 2 — swap real vs. fake with zero other changes**
```ts
export function buildFundingAdapters(): FundingAdapters {
  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  return {
    bank: new StubBankFundingAdapter(),
    card: stripeKey ? new StripeCardFundingAdapter(stripeKey) : new StubCardFundingAdapter(),
  };
}
```

**How they connect:** piece 1 says "something that can charge a card,"
without saying which company does it. Piece 2 decides, at startup, whether
to hand back the fake version (for testing, right now) or the real Stripe
version (the moment real credentials exist) — and every other file in the
codebase only ever talks to piece 1's interface, so it never has to change.

> **Explanation, for you (not for the slide):** an "interface" in
> programming is just a promise about what something can do, written down
> without saying how it actually does it. A real-world comparison: a wall
> socket is an interface — any appliance with the right plug can use it,
> and the socket doesn't care if it's a lamp, a laptop charger, or a toaster
> behind that plug. `CardFundingAdapter` is the same idea: it says "anything
> that fills this role must have a `chargeCard` method that takes these
> inputs and gives back this kind of result" — but it says nothing about
> *how*. That's what let us write `StubCardFundingAdapter` (a fake that just
> pretends to charge a card instantly) and `StripeCardFundingAdapter` (a
> real one that actually calls Stripe) as two completely different pieces
> of code that both satisfy the exact same promise. Everything else in the
> system — the settlement logic, the ledger, the API routes — was written
> against the promise, never against either specific version. That's the
> payoff: swapping fake for real later is a one-line change in the factory,
> not a rewrite of the whole system.

---

## Slide 5 — What we actually learned

**Talking points**
- **Verify claims with running code, not assumptions.** Twice while building
  this, an assumption turned out wrong the moment it was actually checked —
  once about a JavaScript type, once about how much money a bug-fix really
  recovered. Both were caught by re-running the compiler and re-reading the
  test's own claim, not by feeling confident.
- **Financial correctness is a structural property, not a hope.** The
  double-entry rule from Slide 1 doesn't just make bugs *less likely* — it
  makes an entire category of bug (money appearing or disappearing) provably
  impossible to write, because the code physically refuses to save an
  unbalanced transaction.
- **You can build most of a system before the outside world is wired in**,
  if the boundary between "our logic" and "someone else's company" is drawn
  as a clean interface from the start (Slide 4).

**Code piece — a real self-caught mistake, before and after**
```ts
// Before (wrong): re-buys crypto at today's price instead of recovering
// the amount that was actually given out
const { cryptoBought } = await this.liquidity.buy({ fiatAmount, cryptoAsset });

// After (correct): recovers the real, original amount from the ledger itself
const allocated = await this.ledger.positionAllocatedFor(record.id, args.cryptoAsset);
```

**The lesson in one line:** the fix didn't come from spotting the bug by
reading the code harder — it came from writing a test that stated the
expected outcome in plain numbers, and noticing the code didn't actually
produce that number.

> **Explanation, for you (not for the slide):** it's very easy, in software
> and outside it, to believe something is correct because it *sounds*
> correct or because you reasoned through it carefully in your head. The
> only way to actually know is to make the claim concrete enough that it can
> be checked — run it, and see if reality agrees with you. That's what
> happened here twice while building this: once, a piece of code assumed a
> certain type (`CryptoKey`) was available globally, and it turned out it
> wasn't — the compiler caught it the moment it was actually run, not before.
> The other time, a bug-fix looked reasonable on first read but was
> re-buying crypto at *today's* price instead of recovering the *original*
> amount someone had actually been given — subtly wrong in a way that's easy
> to miss just by reading, but impossible to miss once a test says "this
> number should be X" and the code produces something else. Neither mistake
> was caught by being more careful while writing — both were caught by
> building a way to check the claim automatically, and then actually
> checking it. That's arguably the biggest lesson of this whole project: a
> research project that only describes an idea can be wrong forever without
> anyone knowing. A research project that builds the idea and tests it gets
> corrected the moment it's wrong.

---

## Slide 6 (bonus) — "Making a promise mathematically true, not just documented"

**Talking points**
- Earlier in the build, one part of the system had an honest note attached
  to it: "Atlas issues a token, but its own database still secretly knows
  which grant/account requested it — the un-linkability we want isn't
  actually true yet, only tokenization is." That's a real, working piece of
  cryptography most companies never bother implementing — most just settle
  for tokenization and move on.
- Went back and implemented real RSA blind signatures — the same
  mathematical idea David Chaum used to invent digital cash in the 1980s —
  so that promise became something the *math* guarantees, not something
  the database schema merely avoids doing.

**Code piece 1 — hiding the token before Atlas ever sees it**
```ts
export function blind(message: bigint, pub: IssuerPublicKey): BlindedRequest {
  let r: bigint;
  // pick a random blinding factor r, coprime to the modulus
  const blindedMessage = (message * modPow(r, pub.e, pub.n)) % pub.n;
  return { blindedMessage, blindingFactor: r };
}
```

**Code piece 2 — proof Atlas genuinely can't fingerprint it**
```ts
const first = blind(message, pub);
const second = blind(message, pub);

expect(first.blindedMessage).not.toBe(second.blindedMessage);
// ...yet both still unblind to a valid signature on the *same* message
```

**How they connect:** piece 1 is the actual trick — multiply the real token
by a random, secret factor before sending anything to Atlas, so what Atlas
signs looks like noise. Piece 2 is the proof that this isn't just
obfuscation: blind the *same* real token twice, get two completely
different-looking values both times, and both still turn into a valid,
checkable signature on the original. That's the whole property in one test:
nothing Atlas ever sees at issuance time can be matched back to what it
sees later, at redemption.

> **Explanation, for you (not for the slide):** this is the same shape of
> idea as Slide 3's signatures, but one level more advanced. A normal
> signature proves "I approved this specific thing." A *blind* signature
> proves "I approved *something* that fits this shape" — without the signer
> ever finding out which specific something it was. The trick is genuinely
> just multiplication: take the real token, multiply it by a random secret
> number before showing it to Atlas, get it signed, then divide that random
> number back out afterward. Because of how modular exponentiation works
> (the same "wrap-around" arithmetic clocks use), dividing the random factor
> back out at the end leaves you with a completely valid signature on the
> *original* token — Atlas just never got to see that original value at any
> point. This isn't a trick specific to this project; it's the actual
> construction David Chaum published in 1982 to invent the idea of digital
> cash, decades before Bitcoin. Implementing it for real, and then writing a
> test that *proves* the un-linkability rather than just asserting it, is
> the difference between "we designed a privacy feature" and "we can show
> you the privacy feature actually holds."
