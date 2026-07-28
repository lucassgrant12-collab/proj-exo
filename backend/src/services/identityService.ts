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

  /** Resolves a raw public key back to its server-assigned identity id.
   * Public keys aren't secret, so this needs no auth — but it's the one
   * lookup a recovered keypair genuinely can't do without: after Shamir
   * recovery reconstructs the private key client-side, the client still has
   * no way to know which server-side identity row it belongs to until it
   * asks. See web/api.js's recoverIdentity(). */
  async findByPublicKey(publicKey: string) {
    return this.db.identity.findUnique({ where: { publicKey } });
  }
}
