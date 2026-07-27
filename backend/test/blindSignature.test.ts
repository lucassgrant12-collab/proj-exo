import { beforeAll, describe, expect, it } from "vitest";
import {
  blind,
  blindSign,
  createRandomTokenMessage,
  generateIssuerKeyPair,
  publicKeyOf,
  unblind,
  verify,
  type IssuerKeyPair,
} from "../src/domain/blindSignature.js";

describe("domain/blindSignature — real RSA blind signatures, no mocks", () => {
  let issuer: IssuerKeyPair;

  beforeAll(() => {
    // Real RSA key generation (Node's actual crypto, not a fixture) — slow
    // enough (2048-bit) that it's worth doing once for the whole file
    // rather than per test.
    issuer = generateIssuerKeyPair(2048);
  }, 20_000);

  it("round trip: blind -> sign -> unblind -> verify succeeds", () => {
    const pub = publicKeyOf(issuer);
    const message = createRandomTokenMessage(pub.n);

    const { blindedMessage, blindingFactor } = blind(message, pub);
    const blindSignature = blindSign(blindedMessage, issuer);
    const signature = unblind(blindSignature, blindingFactor, pub);

    expect(verify(message, signature, pub)).toBe(true);
  });

  it(
    "unlinkability: blinding the same message twice produces two completely " +
      "different blinded values — nothing Atlas sees at issuance fingerprints " +
      "the token it will later see at redemption",
    () => {
      const pub = publicKeyOf(issuer);
      const message = createRandomTokenMessage(pub.n);

      const first = blind(message, pub);
      const second = blind(message, pub);

      expect(first.blindedMessage).not.toBe(second.blindedMessage);
      expect(first.blindingFactor).not.toBe(second.blindingFactor);

      // Both still unblind to valid signatures on the *same* underlying
      // message, despite Atlas having signed two unrelated-looking values.
      const sig1 = unblind(blindSign(first.blindedMessage, issuer), first.blindingFactor, pub);
      const sig2 = unblind(blindSign(second.blindedMessage, issuer), second.blindingFactor, pub);
      expect(verify(message, sig1, pub)).toBe(true);
      expect(verify(message, sig2, pub)).toBe(true);
    },
  );

  it("rejects a signature over a message that was never actually signed", () => {
    const pub = publicKeyOf(issuer);
    const realMessage = createRandomTokenMessage(pub.n);
    const forgedMessage = createRandomTokenMessage(pub.n);

    const { blindedMessage, blindingFactor } = blind(realMessage, pub);
    const signature = unblind(blindSign(blindedMessage, issuer), blindingFactor, pub);

    expect(verify(realMessage, signature, pub)).toBe(true);
    expect(verify(forgedMessage, signature, pub)).toBe(false);
  });

  it("rejects a signature checked against a different issuer's public key", () => {
    const otherIssuer = generateIssuerKeyPair(2048);
    const pub = publicKeyOf(issuer);
    const message = createRandomTokenMessage(pub.n);

    const { blindedMessage, blindingFactor } = blind(message, pub);
    const signature = unblind(blindSign(blindedMessage, issuer), blindingFactor, pub);

    expect(verify(message, signature, publicKeyOf(otherIssuer))).toBe(false);
  }, 20_000);

  it("a client cannot forge a valid signature without Atlas's cooperation", () => {
    const pub = publicKeyOf(issuer);
    const message = createRandomTokenMessage(pub.n);
    // No blindSign call at all — just guessing a "signature".
    const guessedSignature = createRandomTokenMessage(pub.n);
    expect(verify(message, guessedSignature, pub)).toBe(false);
  });
});
