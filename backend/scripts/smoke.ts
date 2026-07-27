/**
 * End-to-end smoke test against a real database. Requires DATABASE_URL to
 * point at an actual Postgres instance — this sandbox had none available
 * (no Docker, no local Postgres), so this script is verified by type-check
 * and code review, not by a captured run, until it's executed in the real
 * deployment environment. Everything it exercises (money, ledger, permission
 * grant, settlement, auth) already has passing unit tests in test/ that run
 * without a database — see README.md for exactly what has and hasn't been
 * run for real.
 *
 * Run with: DATABASE_URL=postgresql://... npm run smoke
 */

import type { webcrypto } from "node:crypto";
import { prisma } from "../src/db/client.js";
import { IdentityService } from "../src/services/identityService.js";
import { FundingSourceService } from "../src/services/fundingSourceService.js";
import { SettlementService } from "../src/services/settlementService.js";
import { WithdrawalService } from "../src/services/withdrawalService.js";
import { SpendTokenService } from "../src/services/spendTokenService.js";
import { LedgerService } from "../src/services/ledgerService.js";
import { Money } from "../src/domain/money.js";
import { registrationChallenge } from "../src/domain/auth.js";
import { bytesToBase64 } from "../src/domain/encoding.js";
import { StubBankFundingAdapter, StubCardFundingAdapter } from "../src/adapters/funding/stub.js";
import { StubLiquidityAdapter } from "../src/adapters/liquidity/stub.js";
import { StubCustodyAdapter } from "../src/adapters/custody/stub.js";
import { ASSETS } from "../src/domain/money.js";

/** Stands in for what happens client-side in the real app: generate an
 * Ed25519 keypair locally, sign the registration challenge with it. The
 * private key never leaves this function — only the public key and the
 * signature are sent to the server, exactly as domain/auth.ts expects. */
async function generateClientKeypairAndRegistrationProof() {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as {
    publicKey: webcrypto.CryptoKey;
    privateKey: webcrypto.CryptoKey;
  };
  const publicKeyBase64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
  const challenge = new TextEncoder().encode(registrationChallenge(publicKeyBase64));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, challenge));
  return { publicKeyBase64, registrationSignatureBase64: bytesToBase64(signature) };
}

async function seedAssets() {
  for (const asset of Object.values(ASSETS)) {
    await prisma.asset.upsert({
      where: { code: asset.code },
      create: { code: asset.code, decimals: asset.decimals, kind: asset.kind },
      update: {},
    });
  }
}

async function main() {
  console.log("== Atlas backend smoke test ==\n");
  await seedAssets();

  const identities = new IdentityService(prisma);
  const sources = new FundingSourceService(prisma);
  const ledger = new LedgerService(prisma);
  const card = new StubCardFundingAdapter();
  const settlement = new SettlementService(
    prisma,
    { bank: new StubBankFundingAdapter(), card },
    new StubLiquidityAdapter(),
  );
  const withdrawals = new WithdrawalService(prisma, new StubCustodyAdapter());

  // 1. Identity — registered with a real Ed25519 keypair and a signature
  // proving possession of the private key, exactly as domain/auth.ts requires.
  const { publicKeyBase64, registrationSignatureBase64 } = await generateClientKeypairAndRegistrationProof();
  const identity = await identities.register({
    publicKey: publicKeyBase64,
    registrationSignature: registrationSignatureBase64,
  });
  console.log(`Identity registered: ${identity.displayId} (fingerprint ${identity.publicKeyFingerprint})`);

  // 2. Connect a stolen card (for the purposes of this scenario) and grant permission.
  const fundingSource = await sources.connect({
    identityId: identity.id,
    kind: "CARD",
    rail: "CARD_NETWORK",
    label: "Visa •••• 4471",
    externalRef: "stub_card_ref_1",
  });
  const grant = await sources.createGrant({
    identityId: identity.id,
    fundingSourceId: fundingSource.id,
    limit: Money.fromDecimalString("GBP", "1000.00"),
    windowSeconds: 86400,
    singleUse: true,
  });
  console.log(`Permission grant created: £1000 limit, single-use`);

  // 3. Execute the card-funded crypto purchase — Transaction A + liquidity
  // purchase + position allocation, held per §10's buy-then-hold pattern.
  const purchase = await settlement.executeCardFundedCryptoPurchase({
    identityId: identity.id,
    grantId: grant.id,
    fiatAmount: Money.fromDecimalString("GBP", "1000.00"),
    cryptoAsset: "BTC",
  });
  console.log(`Purchase executed: ${purchase.cryptoAllocated.toString()} allocated, settlement ${purchase.settlementRecordId} is HELD`);

  const btcBalanceAfterPurchase = await ledger.balanceOf(identity.id, "BTC");
  console.log(`Identity BTC balance (immediately visible, per §10): ${btcBalanceAfterPurchase.toString()}`);

  // 4. Simulate the true cardholder disputing the charge weeks later — but
  // in this run, the dispute is caught *inside* the hold window, so the
  // position can still be recovered.
  card.simulateDispute(fundingSource.externalRef);
  const reversal = await settlement.reverseSettlement({
    settlementRecordId: purchase.settlementRecordId,
    identityId: identity.id,
    cryptoAsset: "BTC",
  });
  console.log(`\nChargeback processed. Crypto recovered: ${reversal.recoveredCrypto}`);

  const finalBtc = await ledger.balanceOf(identity.id, "BTC");
  const finalOperating = await ledger.systemBalance("ATLAS_OPERATING", "GBP");
  const finalCustodyPool = await ledger.systemBalance("ATLAS_CUSTODY_POOL", "BTC");

  console.log(`\nFinal state after the disputed purchase:`);
  console.log(`  Identity BTC position:      ${finalBtc.toString()}`);
  console.log(`  Atlas operating GBP:        ${finalOperating.toString()}`);
  console.log(`  Atlas custody pool BTC:     ${finalCustodyPool.toString()}`);
  console.log(
    `\nThis matches §10's accounting: the position was caught before release, so it was\n` +
      `recovered into the custody pool rather than lost — but the fiat side is still down\n` +
      `until Atlas actually re-sells that recovered BTC, which is a deliberately separate step.`,
  );

  // 5. A second, legitimate purchase — released after its hold window (we
  // fast-forward that manually here rather than waiting 72 real hours) and
  // then withdrawn out of Atlas entirely, exercising the full clean path.
  console.log(`\n-- Second scenario: a legitimate purchase, released and withdrawn --\n`);
  const grant2 = await sources.createGrant({
    identityId: identity.id,
    fundingSourceId: fundingSource.id,
    limit: Money.fromDecimalString("GBP", "500.00"),
    windowSeconds: 86400,
    singleUse: true,
  });
  const purchase2 = await settlement.executeCardFundedCryptoPurchase({
    identityId: identity.id,
    grantId: grant2.id,
    fiatAmount: Money.fromDecimalString("GBP", "500.00"),
    cryptoAsset: "ETH",
  });
  console.log(`Second purchase: ${purchase2.cryptoAllocated.toString()} allocated, HELD`);

  await settlement.releaseHold(purchase2.settlementRecordId);
  console.log(`Hold released — position is now withdrawable.`);

  const withdrawal = await withdrawals.withdraw({
    identityId: identity.id,
    amount: purchase2.cryptoAllocated,
    toAddress: "stub_external_address",
  });
  console.log(`Withdrawn: tx ${withdrawal.txRef}`);

  const finalEthBalance = await ledger.balanceOf(identity.id, "ETH");
  console.log(`Identity ETH balance after withdrawal (should be 0): ${finalEthBalance.toString()}`);

  // 6. A real blind-signed SpendToken, issued and redeemed — playing both
  // the client and Atlas roles explicitly, since there's no separate client
  // app yet. In a real deployment, everything under "CLIENT:" below runs on
  // the user's device, never here.
  console.log(`\n-- Third scenario: a real blind-signed SpendToken --\n`);
  const grant3 = await sources.createGrant({
    identityId: identity.id,
    fundingSourceId: fundingSource.id,
    limit: Money.fromDecimalString("GBP", "50.00"),
    windowSeconds: 86400,
    singleUse: true,
  });

  const spendTokens = new SpendTokenService(prisma);
  const issuerPub = await spendTokens.getIssuerPublicKey();

  // CLIENT: pick a random token, blind it. Atlas never sees the real value.
  const clientRequest = spendTokens.demoClientBlind(issuerPub);
  console.log(`Client generated a token and blinded it before sending anything to Atlas.`);

  // ATLAS: check the grant's allowance, blind-sign without ever seeing the real token.
  const issued = await spendTokens.issue({
    requestingIdentityId: identity.id,
    grantId: grant3.id,
    form: "VIRTUAL_CARD",
    amount: Money.fromDecimalString("GBP", "25.00"),
    blindedMessageHex: clientRequest.blindedMessageHex,
  });
  console.log(`Atlas blind-signed the token, having never seen its real value.`);

  // CLIENT: unblind locally to get a signature on the real, original token.
  const finalized = spendTokens.demoClientUnblind({
    blindSignatureHex: issued.blindSignatureHex,
    blindingFactorHex: clientRequest.blindingFactorHex,
    pub: issuerPub,
  });
  console.log(`Client unblinded locally — Atlas was never involved in, or shown, this step.`);

  // Redeem — Atlas verifies the signature and checks it hasn't been spent
  // before, with no reference anywhere to grant3 or this issuance event.
  const redemption = await spendTokens.redeem({
    identityId: identity.id,
    messageHex: clientRequest.messageHex,
    signatureHex: finalized.signatureHex,
    amount: Money.fromDecimalString("GBP", "25.00"),
  });
  console.log(`Token redeemed: ${redemption.tokenHash}`);

  try {
    await spendTokens.redeem({
      identityId: identity.id,
      messageHex: clientRequest.messageHex,
      signatureHex: finalized.signatureHex,
      amount: Money.fromDecimalString("GBP", "25.00"),
    });
    console.log(`UNEXPECTED: double-spend was not caught.`);
  } catch (err) {
    console.log(`Double-spend correctly rejected: ${(err as Error).message}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
