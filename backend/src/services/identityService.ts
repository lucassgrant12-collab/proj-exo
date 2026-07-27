import type { PrismaClient } from "@prisma/client";
import { prepareNewIdentity } from "../domain/identity.js";
import { verifyRegistrationProof } from "../domain/auth.js";

export class IdentityService {
  constructor(private readonly db: PrismaClient) {}

  /** Registers a new identity. `registrationSignature` must be a signature,
   * from the private key matching `publicKey`, over the fixed challenge
   * string from domain/auth.ts's registrationChallenge — this is what
   * proves the caller actually holds the private key rather than
   * registering a public key that isn't theirs. */
  async register(args: { publicKey: string; registrationSignature: string }) {
    await verifyRegistrationProof({
      publicKeyBase64: args.publicKey,
      signatureBase64: args.registrationSignature,
    });

    const prepared = prepareNewIdentity({ publicKey: args.publicKey });
    return this.db.identity.create({
      data: {
        displayId: prepared.displayId,
        publicKey: prepared.publicKey,
        publicKeyFingerprint: prepared.publicKeyFingerprint,
      },
    });
  }

  async get(identityId: string) {
    return this.db.identity.findUniqueOrThrow({ where: { id: identityId } });
  }
}
