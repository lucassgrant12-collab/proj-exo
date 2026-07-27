# Project Atlas — Research Notes v0.4

Working answers to the Primary Research Questions in the vision doc. This is a
first pass meant to convert "we want the Internet of money" into concrete,
falsifiable design decisions. Where existing systems already solve a piece of
this, I've named them — not to say "just use that," but because any credible
design has to explain why it's different from (or how it composes with) prior
art. Where the brief's framing runs into a hard constraint (usually
regulatory, not technical), I've said so directly rather than papering over
it.

---

## 0. The load-bearing tension, stated up front

The DNS/TCP analogy is useful for framing but breaks in one important way:
DNS resolves names to *locations*, and TCP moves *bits* — neither system is
required to know who you are or whether you're allowed to do what you're
doing. Money movement is not bit movement. The hard part of this protocol is
not routing value across rails — it's that **every rail has a different
answer to "who is allowed to move this, to whom, under what conditions,"**
and that answer is set by regulators, not by protocol design. SWIFT, Visa,
and a bank's core ledger all require identified counterparties (KYC/AML,
sanctions screening, travel rule above certain thresholds). Public
blockchains require none of that at the base layer.

So "hide the rail from the user" is achievable. "Hide the compliance
requirements of the rail from the *protocol*" is not — the protocol has to
absorb that complexity somewhere, because it can't delegate it to the user
(who doesn't know what rail they're on) and it can't ignore it (or it can't
legally touch the bank/card rails at all). This reframes the project:

> Atlas is less "an Internet protocol for money" and more **an intent-based
> settlement router with a compliance and liquidity abstraction layer**,
> exposed through a single cryptographic identity and a single API.

That's a smaller, harder-edged claim than "money should just work like the
Internet," but it's the version that can actually be built. Everything below
assumes this framing.

The sharper version of this thesis, refined through discussion:

> Atlas is a protocol for negotiating and proving financial state
> transitions across heterogeneous settlement systems — not a network that
> replaces banks or blockchains, but a common language of identity, intent,
> claims, guarantees, and settlement that lets existing financial rails
> interoperate.

---

## 0.5 The central research problem: ownership, settlement, and finality

This is now the central open question of the whole project, above any
individual section below: **can ownership be separated from settlement
without reintroducing the single point of trust that fusing them exists to
avoid?**

Every existing financial system conflates three concepts that are actually
independent:

- **Ownership** — the legal/cryptographic right to value.
- **Settlement** — the mechanism that transfers that right.
- **Finality** — the certainty that the transfer cannot be revoked.

```
Bank:        ledger update == ownership == settlement == (finality later)
Bitcoin:     confirmation  == ownership == settlement == finality
Visa:        authorisation != settlement != finality   (already split!)
```

Visa is the tell: card networks already separate authorization (a promise)
from settlement (the actual transfer, batched later) from finality
(chargebacks remain possible for weeks). Traditional finance has *partially*
done this decomposition already, just internally and inconsistently per
rail. This isn't a novel taxonomy Atlas is inventing — it generalizes one
that already exists formally in payments law and central-banking practice:
the EU's Settlement Finality Directive (98/26/EC) and the BIS Committee on
Payments and Market Infrastructures both draw a hard legal line between
"settled" and "final" (an RTGS system gives immediate finality; a deferred
net settlement system settles throughout the day but is only final at
end-of-day batch). Worth citing directly in any regulatory conversation —
Atlas's finality field isn't a technical nicety, it maps onto a defined
legal concept.

### Why fusion exists, and what breaks when you unfuse it

Banks and Bitcoin fuse ownership and settlement because fusion is what gives
atomicity and finality *without* needing a trusted third party to reconcile
anything after the fact — the ledger entry (or the UTXO) simply *is* the
ownership record, so there's nothing to fall out of sync. The moment you
separate a **claim** (§2) from the **evidence** backing it, you introduce a
*time gap* between asserting the claim and it being provably backed. That
gap is exactly where double-spending, fraud, and counterparty risk live —
and it is not a new problem. Gold certificates, correspondent banking
(nostro/vostro), warehouse receipts, wrapped tokens (WBTC), and
reserve-backed stablecoins are all prior attempts at exactly this
separation, and every one of them has, at some point, faced a crisis of "does
the claim still correspond to the evidence?" (bank runs; Terra/UST's peg
break; recurring stablecoin reserve-audit disputes; historical warehouse
receipt fraud).

So the honest answer is: **ownership and settlement can be separated —
that's just what a receipt is — but the separation is unavoidably a place
where counterparty risk lives. Atlas should not try to make that risk
disappear. It should model it and expose it**, rather than pretend a claim
is as good as settled value. Concretely, every claim (§2) should carry:

```
risk_profile:        who/what could cause this claim to fail to settle
settlement_confidence: a score, not a boolean
liquidity_score:      can this actually be settled on demand right now
expiry:               claims are not permanent truths
```

### The missing primitive: Guarantee

The pipeline is not just Identity → Claim → Intent → Settlement. It's
missing the object that makes a route's promises explicit and checkable
*before* execution:

```
Identity → Claim → Intent → Guarantee → Settlement → Attestation
```

A **Guarantee** is the reified, signed output of route selection (§3 step
4) — today that's an internal decision the routing engine makes and then
just executes on. Turning it into a first-class object means Atlas commits,
up front, to specific properties of the chosen route (expected finality,
reversibility, latency, jurisdiction) before money moves, and that
commitment becomes the thing a dispute is measured against: if actual
settlement doesn't match the guarantee, that's a checkable protocol-level
breach, not a vague complaint. This is structurally similar to a binding RFQ
quote or a PSD2 payment-initiation confirmation — a promise with defined
terms, not just a result.

Every settlement rail offers a fundamentally different guarantee, and Atlas
must expose these as protocol properties rather than hide them:

| Rail | Guarantee |
|---|---|
| Bitcoin | irreversible after sufficient confirmations |
| Visa | authorised, but reversible (chargeback window) |
| ACH | settles next business day |
| Cash | immediate physical finality |
| SEPA Instant | near-instant, limited recall window |

### Design principle: the abstraction must not lie

This resolves a real tension in the original brief, which lists "maximum
abstraction" and "complexity hidden underneath" as principles. Those are
still correct for *implementation* detail — which chain, which bank, which
card network is irrelevant to the user and should stay hidden. They are
**wrong** for *guarantee* detail — finality, reversibility, latency, risk.
A Bitcoin transaction and a card authorization are not equivalent, even if
both satisfy the same £50 intent, and an abstraction that pretends otherwise
will eventually get someone's money stuck or disputed with no recourse. The
resolved principle:

> **Hide the how. Never hide the what-you're-guaranteed.**

Practically: every settlement result carries standardized, inspectable
properties — finality class (probabilistic / immediate / reversible /
delayed), reversibility, latency, jurisdiction, proof type, counterparty
assumptions, risk profile — so a single API still means a single
*integration*, but not a false single *guarantee*. This is arguably where
Atlas is more honest than existing "universal payment API" products, most of
which quietly paper over exactly these differences.

---

## 1. Identity

**Question:** can identity be cryptographic instead of account-based, and can
one identity connect banks, wallets, and payment permissions without
over-exposing personal data?

**Answer: yes for the cryptographic root, no for the exemption from
identification — those are separable, and conflating them is the most common
mistake in this space.**

### Design

- **Root identity = a keypair (or key-set), not an account.** The user's
  Atlas identity is a DID-like object: a public key (or a multisig/threshold
  set for recoverability) that signs assertions. This part genuinely can be
  self-sovereign — precedent: [W3C DIDs](https://www.w3.org/TR/did-core/),
  Ethereum account abstraction (ERC-4337), Solana's account model, Sign-In
  with Ethereum.
- **Linked accounts are attestations, not the identity itself.** A bank
  account, a card, an exchange account, an on-chain wallet — each becomes a
  *verifiable credential* bound to the root key: "this key controls a Visa
  debit instrument," "this key is the beneficial owner of on-chain address
  0x…," "this key passed KYC tier 2 with Provider X on date Y." The protocol
  never needs to see the underlying account number to route a payment; it
  needs to see a credential that proves the link and is checkable by the
  counterparties who legally require it.
- **Selective disclosure, not identity-less operation.** Use verifiable
  credentials (VCs) + zero-knowledge proofs so the user can prove *predicates*
  ("KYC'd in the UK," "over 18," "not on a sanctions list," "this account
  belongs to this identity") without handing over the underlying documents to
  every counterparty. The KYC/AML check still has to happen somewhere,
  performed by a regulated party, and its *result* is what gets attested and
  reused — this is "KYC portability," not "KYC avoidance." Precedent:
  Polygon ID, Privado ID (formerly Polygon ID), Ethereum's EAS
  (Ethereum Attestation Service), the EU's eIDAS 2.0 / EUDI Wallet, which is
  explicitly building toward this model for regulated credentials.
- **One identity, many capabilities, tiered by attestation strength.** An
  identity with zero attestations can still exist and hold/move
  permissionless assets (crypto-native rails). The moment a transaction
  touches a regulated rail (bank transfer, card network, fiat off-ramp), the
  protocol requires the relevant attestation to exist and be presentable —
  otherwise it routes around that rail or declines.

### What this buys you

- Users don't juggle "accounts" per institution — they hold one key(-set)
  and a bundle of attestations.
- Institutions still get what they're legally required to get (identified,
  verifiable counterparties) — Atlas isn't asking a bank to accept an
  anonymous counterparty, which no design can make a bank do.
- Recovery is a solved-ish problem space (social recovery, MPC, passkeys) —
  don't reinvent it; adopt ERC-4337 / passkey-based account abstraction
  patterns.

### Open question

Who issues the base attestations, and does Atlas become a Verifiable
Credential *issuer* itself (i.e., does it run/partner with a KYC provider),
or purely a *verifier/consumer* of credentials issued by regulated partners?
I'd default to the latter — issuing identity credentials is a heavily
regulated business in itself and conflates Atlas-the-router with
Atlas-the-KYC-provider. Cleaner to be a consumer and let banks/licensed KYC
vendors remain issuers.

---

## 2. Financial State Object (formerly "Universal Value Object")

**Question:** what represents ownership independent of where an asset is
stored, and can one ownership model span many settlement systems?

Renamed deliberately: this object doesn't store money, it stores **the
current truth about a financial position** — closer in spirit to what
finance already calls a *position* (a claim/exposure independent of how or
where it's held) than to a token. "Value object" implies something fungible
and self-contained that moves; what's actually being modeled is a position's
*state*, including how confident Atlas is that the state is currently true
(see §0.5's risk/confidence fields). Either **Financial State Object** or
plain **Position** works as the name — Position has the advantage of already
being fluent to bankers and traders rather than a new coinage.

### The core abstraction

Split "ownership" from "custody location" and from "settlement
representation." Three layers:

1. **Claim** — a signed, timestamped assertion: *identity X has an
   economically enforceable right to N units of asset A, currently evidenced
   at location L.* This is the thing Atlas actually tracks natively, and it
   carries the risk/confidence/liquidity/expiry metadata described in §0.5
   rather than presenting itself as settled fact.
2. **Evidence** — the proof that the claim is currently valid: a bank
   balance API response + attestation from the bank, a UTXO/account balance
   on a blockchain with a light-client or oracle proof, a custodian's
   attestation of tokenized-asset holdings. Evidence has a trust model that
   varies by source (trust-the-bank vs. trust-the-chain's-consensus vs.
   trust-a-custodian) — the protocol must carry that trust-level as metadata,
   not hide it, because it changes what a downstream party is willing to
   accept.
3. **Settlement instrument** — the actual thing that moves when a transfer
   is finalized (a SWIFT MT103, an on-chain transfer, a card authorization, a
   stablecoin mint/burn). This is chosen at *execution time* by the routing
   engine, not fixed to the claim.

This is essentially "receipts over reality": the Financial State Object
is a **receipt structure**, not a token you move around. Moving value across
rails means: burn/lock the claim against evidence A, produce a new claim
against evidence B, with the routing engine responsible for the atomic (or
correctly-hedged non-atomic) handoff in between. This is the same shape as
how correspondent banking already works (nostro/vostro accounts,
lock-and-mint bridges, wrapped assets) — the innovation isn't a new ownership
primitive so much as making that pattern uniform, auditable, and automatic
across *every* rail instead of bespoke per bridge/correspondent pair.

### Why not "one universal token that represents everything"

That's the naive version (a mega-stablecoin backed by everything) and it
concentrates all counterparty/custody risk into a single issuer, which is
both a regulatory nightmare (you've just created a shadow bank / e-money
issuer at global scale) and a single point of failure. The claim/evidence
split keeps risk attributable to the actual custodian of each underlying
asset — Atlas is the router and record-keeper of claims, not the issuer of a
new universal liability.

### Verification

Claims are verified against evidence continuously (or at time of use) via:
- **Regulated custodians / banks**: API + legal attestation (trust = legal
  system + bank's own controls).
- **Public blockchains**: cryptographic proof (trust = chain consensus).
- **Tokenized RWAs / CBDCs**: issuer attestation + on-chain proof, hybrid
  trust.

The protocol should expose this trust tier explicitly to counterparties and
to routing decisions (a merchant may refuse to accept a claim evidenced by a
custodian they don't trust, exactly like refusing a personal check).

---

## 3. Settlement Engine

**Question:** given payer, payee, amount — pick the route (cost, speed,
safety, compliance, liquidity) with no user interaction.

This is the piece with the most direct precedent: **intent-based
architectures**. The user (or app) states an *intent* ("move £100 worth of
value from A to B, arriving as GBP in B's bank account, by end of day"), and
a solver network or routing engine competes/computes to fulfill it. Precedent
to study closely: UniswapX, CowSwap, Anoma, NEAR's chain abstraction /
"chain signatures," Li.Fi and Socket (cross-chain bridge aggregation), and —
closer to the fiat side — Stripe/Wise/Airwallex's internal treasury routing
and RFQ engines, which already do "pick cheapest/fastest FX + rail" behind a
single API. Atlas's settlement engine is structurally the same problem as
those, generalized across fiat rails *and* chains *and* card networks.

### Proposed architecture

1. **Intent** (in): `{from: identity, to: identity, asset/value: X, constraints: {max_fee, max_time, min_finality_confidence, jurisdiction_constraints, preferred_rails?}}`
2. **Candidate route generation**: query liquidity/rail adapters (bank rail
   adapter, card rail adapter, chain adapters, stablecoin on/off-ramp
   adapters) for feasible paths, each returning `{cost, expected_time,
   finality_guarantee, compliance_requirements_satisfied?}`.
3. **Compliance gate** (hard filter, not a scoring factor): drop any route
   whose required attestations aren't present for both parties. This has to
   run *before* optimization, not as a tiebreaker — you cannot let "cheapest
   route" ever be a route that's non-compliant, or the whole protocol is
   legally unshippable.
4. **Multi-objective selection**: score remaining routes against the
   requester's stated preference (cost/speed/safety weighting) — not a
   single hardcoded "best," since "best" is policy, and policy should be
   overridable by the user/app (a merchant might always prefer "safest,"
   a remittance app might always prefer "cheapest").
5. **Guarantee** (see §0.5): reify the selected route's promised properties
   — finality class, reversibility, latency, jurisdiction, proof type — into
   a signed object presented to the requester *before* execution. This turns
   step 4's internal decision into an externally checkable commitment: if
   real settlement diverges from the guarantee, that divergence is a
   protocol-level breach, not an unfalsifiable claim.
6. **Execution**: for single-rail routes, straightforward. For
   multi-hop/cross-rail routes (e.g., card → stablecoin → local bank rail),
   this needs either (a) atomicity via HTLC-style conditional locks where
   the underlying rails support it, or (b) pre-funded liquidity pools on
   both sides with the protocol taking *inventory risk* and rebalancing
   asynchronously (this is how Wise, most bridges, and correspondent banking
   actually work in practice — true atomic cross-rail settlement is rare
   because most rails don't support it). Be honest in the design that (b) is
   the common case and requires Atlas (or its liquidity partners) to hold
   working capital and manage FX/inventory risk — this is a real business,
   not just software.
7. **Attestation**: emit a signed settlement receipt referencing the claim
   transformations in §2 and checked against the Guarantee from step 5, for
   audit and dispute resolution.

### Key design decision to flag to you

Step 6(b) means Atlas (or whoever operates liquidity for it) is economically
exposed like a payments/FX business, not a neutral pipe. That's fine — it's
how Wise, Airwallex, and every bridge aggregator work — but it means "the
protocol" isn't just software; it implies an operating company holding
liquidity, licenses (money transmission, EMI, etc.), and risk. Worth deciding
explicitly whether Atlas is (a) the protocol + a reference liquidity
operator, or (b) a protocol that *other* licensed liquidity providers plug
into competitively (more Internet-like, more defensible long-term, much
harder to bootstrap).

---

## 4. Asset Layer

**Question:** make bank deposits, stablecoins, BTC, ETH, SOL, tokenized
assets, CBDCs interoperable.

Treat every asset as `{unit-of-account, issuer/evidence-type, transport
rail}` and normalize only the *unit of account* piece centrally; leave
transport heterogeneous behind rail adapters. Concretely:

- **Adapter pattern**, one per rail family: bank-rail adapter (ISO 20022 /
  SWIFT / ACH / Faster Payments / SEPA), card-rail adapter, EVM-chain
  adapter (generic, parameterized per chain), Solana adapter, Bitcoin
  adapter (UTXO model is genuinely different, don't fake unification —
  abstract at the interface, not the implementation), stablecoin
  issuer/redemption adapter (Circle's CCTP is a good existing pattern for
  native-mint-and-burn cross-chain transfer, worth studying directly), CBDC
  adapter (speculative — CBDC designs vary a lot by jurisdiction and most
  aren't live; don't over-invest here yet).
- **Each adapter exposes two things, not one**: a static **capability
  profile** — `can_lock?`, `can_reverse?`, `expected_finality`,
  `settlement_latency`, `liquidity_available`, `jurisdiction`, `proof_type`
  — used at route-candidate-generation time (step 2) and to construct the
  Guarantee (step 5 in §3); and a common set of **verbs** — `quote(amount,
  from, to) -> {fee, time, confidence}`, `lock/reserve`, `execute`,
  `prove_settlement` — used to actually perform a specific transfer once a
  route is chosen. Capabilities answer "what's possible on this rail";
  verbs answer "make this specific transfer happen." This is the actual
  "universal" part — not that BTC and a bank deposit *become the same
  thing*, but that every rail exposes the same shape of capability
  description and the same verbs to the routing engine, so Atlas becomes a
  **negotiation engine** rather than a layer that pretends every rail
  behaves identically.
- **Valuation/pricing** needs its own service (oracle layer) to compare
  "value" across assets with different denominations — this is a real
  component (think Chainlink-style oracles + FX rate feeds), not an
  afterthought, since the whole "amount" concept in an intent is meaningless
  without a shared pricing reference.

### Where this is genuinely hard

Finality semantics differ wildly (card auth can be reversed/charged back
weeks later; a confirmed Bitcoin transaction is final in ~10-60 min;
SWIFT wires are final but slow; some chains have probabilistic finality).
The routing engine's `min_finality_confidence` constraint (§3) has to be
rail-aware and honest about this — never present a card-network route as
having the same finality guarantee as an on-chain settled route. This is a
common source of real fraud/loss in naive bridge/ramp designs — flag it as a
first-class risk, not a detail.

---

## 5. Address Abstraction

**Question:** replace `0x...`/`bc1...`/account numbers with one identity;
resolve identity → destination → route like DNS.

This is the most directly DNS-like part of the brief and the most
straightforward to design well:

- **Resolution record type**, per identity: a signed document (analogous to
  a DNS zone file) listing the identity's linked destinations *and the
  attestations proving control of each* — `{rail_type, destination_ref
  (opaque to the user), proof_of_control, supported_assets, preferred: bool}`.
- **Resolution is not "look up the address"** — it's "look up the address
  *conditioned on* the sender's route requirements," because which
  destination is reachable depends on compliance/rail compatibility (e.g. a
  US sender may only be able to reach a subset of a payee's linked
  destinations due to sanctions/jurisdiction rules). So the resolver is
  really a thin client to the settlement engine (§3), not a pure lookup —
  worth naming as ENS/DNS-*inspired*, not DNS-*equivalent*, since DNS
  resolution has no such conditionality.
- **Human-readable handles** (like ENS names or Lightning addresses /
  email-style identifiers) sit on top purely for UX — precedent: ENS,
  Unstoppable Domains, Lightning's LNURL/Lightning Address (`name@domain`
  resolving to a payment endpoint) is a very close existing analog worth
  studying directly, as is UPI (India) and PayNow (Singapore) — real-world,
  already-deployed "you don't need the account number, just an identifier"
  systems at massive scale. Studying UPI in particular is probably higher
  value than studying any crypto system for this specific question, since it
  is the existing system closest to "solved this exact problem for a billion
  users."

---

## 6. Permissions

**Question:** cryptographically verifiable, revocable, scoped permissions
("this app may request up to £100") instead of direct financial access.

Directly maps to **account abstraction session keys / spending policies**,
already partially deployed:

- Precedent: ERC-4337 session keys, Safe's modules, Apple/Google Pay's
  per-merchant tokenization (a card number given to a merchant is *already*
  a scoped, revocable credential distinct from your real PAN — this pattern
  predates crypto and is worth crediting), OAuth scopes (the web-permissions
  analog), Coinbase's spend permissions / smart wallets.
- **Design**: a permission = a signed capability object: `{grantor: identity,
  grantee: app_identity, max_amount, currency/asset, time_window,
  rate_limit, revocable: true, valid_until}`. Grantee presents this to the
  routing engine when initiating an intent on the grantor's behalf; the
  engine validates signature + remaining allowance before executing, and
  decrements allowance atomically.
- **Revocation**: needs an on-chain-or-equivalent revocation registry
  checked at execution time (not just "delete the key locally," which
  doesn't stop a malicious or compromised app that cached it) — same
  problem OAuth token revocation has, same solution shape (short-lived
  tokens + revocation list, or a nonce/counter-based scheme).
- This is the component with the *least* regulatory novelty and the *most*
  reusable prior art — I'd prioritize building this first since it de-risks
  the least and validates the account-abstraction identity layer (§1)
  end-to-end.

---

## 7. Smart Routing

Folded into §3 — routing and settlement are the same engine; "smart routing"
is just the multi-objective optimization step (2/4) inside the settlement
pipeline. Calling it out separately in the brief is fine conceptually but
architecturally it's one component, not two.

One addition: **routing preference should be a first-class, inspectable
policy object per identity/app**, not a hidden heuristic — for the same
reason banks/regulators will want to audit *why* a route was chosen
(best-execution obligations exist in traditional finance, e.g. MiFID II's
best-execution rule for trades — an analogous obligation is a plausible
regulatory expectation for a payment router of this kind).

---

## 8. Developer Platform

**Question:** one API instead of separate integrations with Visa,
SWIFT, Ethereum, Solana, exchanges.

- This is a product-layer concern once §1–§7 exist; the main design risk is
  **leaky abstraction** — if the unified API can't express rail-specific
  detail when a developer genuinely needs it (e.g., card-specific 3DS
  challenge flows, chain-specific gas sponsorship, bank-specific reference
  fields/remittance info), developers will bypass the abstraction, same
  failure mode that killed several "universal payment API" startups.
  Precedent worth studying for *both* what worked and what didn't: Stripe
  (excellent abstraction, but Stripe explicitly does NOT hide card vs.
  ACH vs. wallet distinctions from developers when it matters — it exposes
  a common object model but lets you drop into rail-specific fields),
  Plaid (bank abstraction), and various "universal crypto payment" APIs
  that failed to get adoption because they over-abstracted and couldn't
  handle edge cases.
- Recommend: common object model + typed "escape hatches" per rail adapter,
  not a lowest-common-denominator API.

---

## Cross-cutting risks (say these out loud early)

1. **Regulatory classification.** Depending on exactly what Atlas does
   operationally (does it ever hold funds? net settle? issue any
   instrument?), it may need money transmitter licenses (US, state-by-state),
   EMI/PI licensure (UK/EU), or equivalent in every jurisdiction it touches.
   This is the single biggest determinant of what's actually buildable in
   what order, bigger than any technical choice above. Worth getting a
   regulatory read *before* committing to whether Atlas ever takes custody
   (§3 step 6b) — the "protocol not a company" framing gets much harder the
   moment it holds liquidity.
2. **Liability and dispute resolution.** Traditional rails have chargebacks,
   deposit insurance, ombudsman schemes, legal recourse. Crypto rails
   mostly don't. A protocol that routes a single logical payment across both
   needs an explicit, disclosed answer to "what happens when this specific
   hop fails or is disputed" per rail-pair — this can't be hand-waved as
   "the protocol figures it out."
3. **Sanctions/travel-rule compliance at the routing layer**, not bolted on
   after. FATF travel rule (originator/beneficiary info for transfers above
   thresholds) has to be a routing constraint (§3 step 3), not a filter
   applied after picking a route.
4. **This is a two-(or n-)sided liquidity network**, and bootstrapping
   n-sided networks is a go-to-market problem at least as hard as the
   technical one — worth acknowledging that "build the protocol" and
   "get banks/rails to plug into it" are separate, sequential efforts, and
   the latter usually takes longer.

---

## Suggested build/research order

Given the above, the components with the most reusable prior art and least
regulatory novelty (cheapest to de-risk first) come before the components
that require licensure or institutional partnerships:

1. **Identity + Permissions** (§1, §6) — buildable now with existing
   account-abstraction/DID/VC tooling, no license required to prototype.
2. **Financial State Object + adapters for crypto-native rails only**
   (§2, §4 restricted to on-chain assets) — provable end-to-end without
   touching banks/cards yet.
3. **Settlement engine, single-rail then multi-hop, still crypto-native**
   (§3) — validates the intent/routing architecture before regulatory
   complexity is added.
4. **Address abstraction / resolution** (§5) — layers on cheaply once 1–3
   exist.
5. **Fiat/bank/card adapters** (§4 extended) — only once there's a licensing
   plan or a licensed partner, since this is where "protocol" becomes
   "regulated financial business."
6. **Developer platform/API** (§8) — productize once the above is proven
   with at least one real fiat rail, not before, or the API surface will be
   guessed rather than informed.

---

## 9. Spend delegation and the anonymity layer (v0.3)

This section didn't come from the original brief's research questions — it
came out of actually building the prototype, connecting sources, and asking
what Atlas's core mechanism really is once the UI is stripped away. It's
included here because the answer reframes the product, not just adds a
feature to it. This is an active research direction, not a settled design —
treat everything below as a first pass to keep arguing with, not a spec.

### The core mechanism, restated precisely

Atlas doesn't hold funds and doesn't operate its own settlement rail. It's a
**permissioned spending delegate**: a user grants Atlas a scoped, revocable
authorization against a real funding source (a card or a bank account), and
Atlas issues its own spending instrument against that authorization — a
token that merchants, chains, and counterparties interact with instead of
the real funding source. The real card number, the real bank details, and
(the new part) the transaction history itself are never exposed to whoever
the user is transacting with, and — per the research-mode design point
below — not retained in a plainly correlatable form by Atlas either.

This reframes what a "connected source" from §2/§4 actually is: it stops
being just an attestation of ownership and becomes a **funding
authorization** that spend tokens draw against.

### Two real mechanisms, not one vague "encryption"

It's worth being precise here, because "encrypt the spending" isn't one
technique, it's two, doing different jobs:

1. **Virtual card tokenization** — the practical layer, already shipping
   today. Privacy.com generates disposable or merchant-locked virtual card
   numbers funded by a real card, so the real PAN never touches a merchant.
   Coinbase Card and Crypto.com Card do the same thing in the other
   direction — spend crypto anywhere Visa is accepted, converted to fiat at
   authorization time. Both run on real card-issuing platforms (Marqeta,
   Lithic) that already handle the regulatory and network relationships.
   This layer gets Atlas "the merchant never sees your real card," for
   free, as a structural side effect of how virtual cards work — no new
   cryptography required.
2. **Blind signatures (Chaumian e-cash)** — the deeper layer, for
   unlinkability from the *issuer*, not just the merchant. David Chaum's
   1980s blind-signature construction lets an issuer validate that a token
   is real and authorized without being able to see which specific token it
   handed to which user — so when the token is later spent, the issuer can
   confirm it's genuine without the spend being linkable back to the moment
   of issuance. Cloudflare's Privacy Pass is a modern production use of the
   same idea. This is the layer that would make "even Atlas itself can't
   easily correlate identity-to-spend" a real, provable property instead of
   a policy promise.

### Internal API primitives

```
Identity
  - keypair-based, as established in §1
  - now also the anchor PermissionGrants are signed against

PermissionGrant
  {
    id,
    identity: <owner>,
    source: <funding source — a connected bank/card attestation from §4>,
    limit: { amount, currency, window },
    constraints: { merchant_category?, single_use?, expiry },
    signature
  }

SpendToken
  {
    id,
    grant: <PermissionGrant ref>,
    form: "virtual_card" | "crypto_address",
    blinded_reference,  // blind-signature output — unlinkable to `grant`
                         // without the blinding factor only the user holds
    status: active | spent | expired | revoked
  }

SettlementAdapter (extends §4)
  - at authorization time: validates the SpendToken against its
    PermissionGrant's remaining limit
  - performs the fiat<->crypto conversion if the funding source and the
    token's denomination differ
  - this is the only place a real-time link between token and source has
    to exist at all, and only for the duration of that one authorization

Ledger
  - per-identity, encrypted at rest under the vault-key model already built
    in the prototype (§0.5's claim/evidence framing applies directly here:
    a ledger entry is a claim about a past spend, evidenced by the
    SettlementAdapter's authorization record)
  - in the research-mode design point, Atlas's own operational store holds
    blinded/encrypted records, not a queryable "identity X spent Y at Z"
    table
```

### Card ↔ crypto, both directions, through the same primitive

- **Card-funded, crypto-denominated**: the real card is the
  `PermissionGrant` source; the `SpendToken` is a crypto address. When
  something is sent to that address, the `SettlementAdapter` charges the
  card and forwards the equivalent crypto position. (This direction already
  exists as a product category — MoonPay, Ramp — made unlinkable here via
  the blinding layer.)
- **Crypto-funded, card-denominated**: a crypto position is the
  `PermissionGrant` source; the `SpendToken` is a virtual card number issued
  through a card-issuing partner. At authorization time, the
  `SettlementAdapter` liquidates the necessary amount of crypto through a
  liquidity relationship and settles with the card network. (This direction
  already exists too — Coinbase Card.)
- The genuinely novel part isn't either direction alone — both already ship
  as separate products elsewhere. It's that both run through the *same*
  `PermissionGrant` / `SpendToken` / blind-signature model, so the
  anonymity property is uniform regardless of which way value is flowing,
  instead of being a card feature bolted onto a separate crypto feature.

### Research-mode design point vs. the eventual real constraint

For the current research phase, the design explores **full unlinkability**:
no persistent, plainly readable link between an `Identity` and a specific
spend, anywhere, including inside Atlas's own systems, achieved through the
blind-signature issuance step. This is a deliberate research choice for
right now, not a final production decision — explicitly not settled, and
worth arguing with.

If this becomes a real, licensed business, this is very likely the first
thing that has to change. AML regulation generally requires a regulated
money-services business to retain the *capability* to identify a
transaction under lawful compulsion, even if it never exercises that
capability routinely. A design that architecturally cannot do this, ever,
under any legal process, sits in the same category that led to Tornado
Cash's developer being prosecuted and the protocol itself being sanctioned
— that's not a hypothetical risk, it's precedent. The defensible production
version keeps the data-minimization and per-user-encryption properties, but
has Atlas retain an escrowed capability — for instance, a compliance key
held under strict legal and procedural controls, able to unlock one
specific record under valid legal process — rather than no capability at
all. Full unlinkability and a licensable business are, as far as this
research has gotten, in direct tension. That tension is unresolved here on
purpose, the same way the ownership/settlement/finality tension in §0.5 is
unresolved on purpose — it's the load-bearing open question of this
section, not a footnote to it.

### Where this lands in the build order

This layer needs a working `Identity` and at least one real funding source
already wired up — so it slots in after the crypto-only MVP phase (step 1–2
of the build order above), and before the fiat/card adapters step, since
`PermissionGrant` and `SpendToken` are most cheaply provable against a
single real crypto rail before a card-issuing partner is ever in the loop.

---

## 10. Regular payment infrastructure — fiat, cards, bank transfers (v0.4)

§9 covers the identity and permission model for spend delegation. This
section is its companion: the concrete "how does money actually move, and
who's exposed when it goes wrong" reasoning, worked through in detail during
the research phase. The conclusion, stated up front: **bank-linked funding
and card-linked funding are not the same problem wearing different clothes —
they're structurally different legal and financial positions, and the
difference isn't a framing choice Atlas gets to make.**

### Two rails, two structurally different roles

- **Bank-linked funding** can genuinely work the way a "permission-based
  delegate" should: under UK/EU Open Banking (PSD2), there's a regulated
  role called a **Payment Initiation Service Provider (PISP)** — authorized
  to trigger a transfer directly from a user's own bank account to a
  destination, using their consent and the bank's own API, without the PISP
  ever taking custody of the funds. Atlas's own account is never a stop
  along the way. This is close to the ideal `PermissionGrant` story: Atlas
  orchestrates, it doesn't receive.
- **Card-linked funding cannot work that way**, and this isn't a design
  choice — it's a hard property of how card networks operate. Every card
  transaction requires a merchant of record: some account designated as the
  receiving party. There is no "agent initiates a card payment without a
  merchant" mode in Visa/Mastercard's system. Whoever's account receives the
  charge *is* the merchant of record as far as the network is concerned,
  regardless of how Atlas describes its relationship to the user in its own
  terms. The `PermissionGrant` / consent layer is Atlas's to design; which
  rail-level role Atlas occupies when executing it is not.

### The two-transaction structure

Every card-funded flow through Atlas is really two separate transactions,
and the exposure lives in only one of them:

- **Transaction A — funding.** The user's real card is charged, and the
  money lands in an account Atlas (or its processor, acting for it)
  controls. This is the transaction a dispute reverses.
- **Transaction B — spend.** Whatever that money is then used for (a
  merchant purchase, a crypto purchase) is already complete and settled by
  the time anyone could dispute anything. The counterparty on this side has
  zero exposure to the original card.

### Where the risk actually comes from

Card authorization is fast; card finality is slow — a transaction stays
disputable for up to ~120 days under network rules. Crypto, by contrast, is
functionally final within the hour and has no reversal mechanism at all
once moved. Any flow that wants to feel instant has to deliver value before
it can be certain the funding side is genuine, and during that gap, someone
is exposed. For card-not-present transactions — which every online, and
therefore every Atlas, transaction is — network liability-shift rules put
that exposure on the merchant, not the issuing bank. The bank is
structurally the least exposed party in this chain; it's built to push the
cost back onto whoever accepted the card.

Two different dispute shapes matter here, and they resolve differently:

- **Genuine theft** — the person transacting isn't the cardholder. No
  amount of evidence saves the receiving party, because none exists showing
  the real cardholder authorized anything. This is fraud protection working
  as intended, and it cannot be waived by terms of service — a business
  cannot contract around identity theft, because the party who was actually
  harmed never agreed to any terms in the first place.
- **Friendly fraud** — a real cardholder genuinely authorized the
  transaction and later falsely disputes it anyway. This is contestable: the
  merchant can submit evidence (authentication logs, device history,
  explicit consent records) through the card network's **representment**
  process, and can win.

### Mitigations, layered — none of them get to zero alone

1. **Strong authentication.** Using Apple Pay / Google Pay instead of raw
   card entry inherits real protections for free: network tokenization
   (merchants never see the real card number), device-provisioning checks,
   and per-transaction biometric-gated cryptographic signing. Pairing this
   with a device-bound passkey for the Atlas identity itself (not the card —
   a separate question, see §9's `Identity` primitive) closes the second
   gap: proving the right *person* is operating this identity, not just that
   the card is real. This is also legally load-bearing: PSD2's **Strong
   Customer Authentication (SCA)** rule explicitly shifts liability toward
   the payment provider when this kind of authentication was properly
   applied — it's the exact mechanism the regulation rewards, not a
   workaround of it.
2. **Explicit consent record at the point of connecting a funding source.**
   Implemented in the prototype: connecting a bank, wallet, or card shows an
   authorization notice before the source is added. This has one real, if
   narrow, purpose — it's evidence in a representment fight against friendly
   fraud, since it establishes what was authorized and when. It is
   explicitly *not* a waiver, and does nothing against genuine theft, since
   the real victim never sees or agrees to it.
3. **Buy-then-hold, not buy-then-release, for crypto specifically.** Execute
   the purchase immediately — locks the price, the user sees their balance
   right away — but gate the ability to withdraw, spend, or convert it until
   a confidence window passes. If the funding charge is flagged as
   fraudulent within that window, Atlas unwinds the position and only eats
   the trading spread, not the full value, because the thief never got
   anything they could move. This doesn't protect against disputes filed
   after the hold closes — card dispute windows run far longer than any
   holding period that preserves a usable product — so it shrinks the fast
   fraud pattern (the dominant one for crypto specifically) without closing
   the gap entirely.
4. **Risk transfer.** Chargeback-guarantee providers (Signifyd, Riskified
   are the two named players in this space) take on approved-transaction
   fraud liability directly, for a fee — real risk transfer, distinct from a
   reserve, which is just Atlas's own revenue held back for liquidity, not
   moved to anyone else. A guarantee converts an unpredictable loss into a
   predictable, budgeted cost; it doesn't make the cost disappear.
5. **Identity-independent signals, because KYC isn't available here.**
   Velocity and amount limits (especially for new/unverified funding
   sources), and device/network fingerprinting *across* identities — Atlas
   can notice "this device has spun up 40 fresh identities and drained a
   card through each one in the past hour" without ever attaching a name to
   any of them. This is the direct consequence of §9's anonymity-first,
   no-KYC design: every mitigation available here has to work without
   knowing who anyone is, because that's the one lever this project has
   already ruled out.

### The sharper version of the anonymity tension

A freely, instantly, anonymously regenerable identity is *more* attractive
to stolen-card-to-crypto fraud than a KYC'd exchange, not equally exposed to
it — a KYC'd exchange at least leaves a trail, even a fake one, that adds
friction and gives investigators something to pull on afterward. Atlas, as
designed in §9, has none of that by construction. This is the concrete,
non-abstract form of the "last 1%" tension the Anonymity page already
gestures at, and it's not solved by anything in this section — the
mitigations above reduce the *rate* and *cost* of this specific attack, they
don't remove the structural reason Atlas is a better target for it than the
status quo.

### Where this leaves "regular payments" vs. crypto, as of this pass

Bank-linked funding, via the PISP model, is comparatively well-understood
and low-risk — Atlas orchestrates, never holds, and the reversal mechanics
for bank transfers are narrower and better-defined than card chargebacks.
Card-linked funding carries real, structural, price-able fraud exposure that
no amount of clever consent language or business-model framing removes,
because it's set by card network rules, not by Atlas. What makes the
*crypto* side of this specifically hard — compared to, say, a card spend at
an ordinary merchant — is that crypto is the fastest, most irreversible
thing stolen funds can be converted into, which is exactly why it needs
continued, dedicated attention rather than being treated as "solved" once
the card/bank funding question is answered.

---

## Open questions for you specifically

- Is Atlas intended to ever hold customer funds/liquidity itself, or purely
  route between licensed third parties? This single answer reshapes the
  entity structure, licensing burden, and §3's design more than anything
  else here.
- Target geography for v0/pilot — UK-only, UK+EU, or global from day one?
  Regulatory scope should probably start narrow (one jurisdiction) even
  though the protocol design stays general.
- Is the near-term goal a research prototype/testnet (crypto-native only,
  per step 1–4 above) or does "financial identity connecting to banks" need
  to be real in the first version?
