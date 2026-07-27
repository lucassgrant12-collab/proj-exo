import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalSigningString,
  InvalidSignatureError,
  registrationChallenge,
  verifyRegistrationProof,
  verifyRequestSignature,
} from "../src/domain/auth.js";
import { bytesToBase64 } from "../src/domain/encoding.js";

async function generateKeypair() {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as {
    publicKey: webcrypto.CryptoKey;
    privateKey: webcrypto.CryptoKey;
  };
  const publicKeyBase64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
  return { publicKey, privateKey, publicKeyBase64 };
}

async function sign(privateKey: webcrypto.CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message));
  return bytesToBase64(new Uint8Array(signature));
}

describe("domain/auth — real Ed25519 signing, no mocks", () => {
  it("verifies a correctly signed request", async () => {
    const { privateKey, publicKeyBase64 } = await generateKeypair();
    const input = { method: "POST", path: "/settlements", timestampMs: Date.now(), bodySha256Hex: "abc123" };
    const signature = await sign(privateKey, canonicalSigningString(input));

    await expect(
      verifyRequestSignature({ publicKeyBase64, signatureBase64: signature, input }),
    ).resolves.not.toThrow();
  });

  it("rejects a signature made with a different identity's key", async () => {
    const signer = await generateKeypair();
    const attacker = await generateKeypair();
    const input = { method: "POST", path: "/settlements", timestampMs: Date.now(), bodySha256Hex: "abc123" };
    const signature = await sign(signer.privateKey, canonicalSigningString(input));

    // The signature is real and valid — just not for the public key it's
    // being checked against, which is the actual thing that must fail.
    await expect(
      verifyRequestSignature({ publicKeyBase64: attacker.publicKeyBase64, signatureBase64: signature, input }),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it("rejects if any signed field is tampered with after signing", async () => {
    const { privateKey, publicKeyBase64 } = await generateKeypair();
    const original = { method: "POST", path: "/settlements", timestampMs: Date.now(), bodySha256Hex: "abc123" };
    const signature = await sign(privateKey, canonicalSigningString(original));

    const tamperedAmount = { ...original, bodySha256Hex: "tampered_hash" };
    await expect(
      verifyRequestSignature({ publicKeyBase64, signatureBase64: signature, input: tamperedAmount }),
    ).rejects.toThrow(InvalidSignatureError);

    const tamperedPath = { ...original, path: "/withdrawals" };
    await expect(
      verifyRequestSignature({ publicKeyBase64, signatureBase64: signature, input: tamperedPath }),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it("rejects a stale timestamp — the replay-protection window", async () => {
    const { privateKey, publicKeyBase64 } = await generateKeypair();
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const input = { method: "GET", path: "/identities/abc", timestampMs: tenMinutesAgo, bodySha256Hex: "" };
    const signature = await sign(privateKey, canonicalSigningString(input));

    await expect(
      verifyRequestSignature({ publicKeyBase64, signatureBase64: signature, input, now: Date.now() }),
    ).rejects.toThrow(/outside the allowed window/);
  });

  it("accepts a timestamp within the clock-skew window", async () => {
    const { privateKey, publicKeyBase64 } = await generateKeypair();
    const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
    const input = { method: "GET", path: "/identities/abc", timestampMs: twoMinutesAgo, bodySha256Hex: "" };
    const signature = await sign(privateKey, canonicalSigningString(input));

    await expect(
      verifyRequestSignature({ publicKeyBase64, signatureBase64: signature, input, now: Date.now() }),
    ).resolves.not.toThrow();
  });

  it("registration proof: verifies possession of the private key for a given public key", async () => {
    const { privateKey, publicKeyBase64 } = await generateKeypair();
    const signature = await sign(privateKey, registrationChallenge(publicKeyBase64));

    await expect(
      verifyRegistrationProof({ publicKeyBase64, signatureBase64: signature }),
    ).resolves.not.toThrow();
  });

  it("registration proof: rejects a signature that doesn't prove possession", async () => {
    const real = await generateKeypair();
    const impostor = await generateKeypair();
    // Impostor tries to register real's public key using their own signature.
    const forgedSignature = await sign(impostor.privateKey, registrationChallenge(real.publicKeyBase64));

    await expect(
      verifyRegistrationProof({ publicKeyBase64: real.publicKeyBase64, signatureBase64: forgedSignature }),
    ).rejects.toThrow(InvalidSignatureError);
  });

  it("rejects a public key that isn't 32 raw bytes", async () => {
    await expect(
      verifyRequestSignature({
        publicKeyBase64: bytesToBase64(new Uint8Array(16)), // wrong length
        signatureBase64: bytesToBase64(new Uint8Array(64)),
        input: { method: "GET", path: "/x", timestampMs: Date.now(), bodySha256Hex: "" },
      }),
    ).rejects.toThrow(/32-byte/);
  });
});
