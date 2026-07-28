/**
 * Real client for the Atlas backend. Every function here does a real
 * network call, real Ed25519 signing, or real key material handling — no
 * simulated data. Signing implements the exact scheme documented in
 * backend/src/api/authMiddleware.ts and backend/src/domain/auth.ts, and was
 * verified end to end against a running backend (register -> connect ->
 * grant -> settle -> balance -> revoke -> recovery lookup) before being
 * written here in this form.
 */

(function (global) {
  "use strict";

  var DEFAULT_API_BASE =
    location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "http://localhost:3000"
      : "https://proj-exo-production.up.railway.app";
  var API_BASE = global.ATLAS_API_BASE || DEFAULT_API_BASE;

  /* ---------------- encoding helpers ---------------- */

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // JWK's `d`/`x` members are base64URL (RFC 8037/7517: no padding, '-'/'_'
  // instead of '+'/'/') — different from the plain base64 used on the wire
  // for X-Atlas-Signature etc., so this needs its own pair.
  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(b64url) {
    var b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    return base64ToBytes(b64);
  }
  async function sha256Hex(str) {
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  /* ---------------- identity: real Ed25519 keypair ---------------- */

  async function generateKeyPair() {
    return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  }

  async function exportPublicKeyB64(publicKey) {
    var raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    return bytesToBase64(raw);
  }

  async function exportPublicKeyBytes(publicKey) {
    return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  }

  /** The 32-byte private seed — what actually gets Shamir-split for
   * recovery. Not the same thing as a signature or the public key; this is
   * the one piece of material that must never leave the device except as
   * secret shares. */
  async function exportSeed(privateKey) {
    var jwk = await crypto.subtle.exportKey("jwk", privateKey);
    return base64UrlToBytes(jwk.d);
  }

  /** Public on purpose (unlike the other internals): script.js calls this
   * once, right after generateKeyPair(), to get the bytes it persists in
   * the local encrypted vault so the identity survives a page reload
   * without needing recovery keys for the common case. */
  async function exportSeedPublic(keyPair) {
    return exportSeed(keyPair.privateKey);
  }

  async function importKeyPairFromSeed(seedBytes, publicKeyBytes) {
    var jwk = {
      kty: "OKP",
      crv: "Ed25519",
      d: bytesToBase64Url(seedBytes),
      x: bytesToBase64Url(publicKeyBytes),
      key_ops: ["sign"],
      ext: true,
    };
    var privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
    var publicJwk = { kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(publicKeyBytes) };
    var publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, true, ["verify"]);
    return { privateKey: privateKey, publicKey: publicKey };
  }

  var REGISTRATION_PREFIX = "ATLAS_IDENTITY_REGISTRATION:";

  async function registerIdentity(keyPair) {
    var publicKeyB64 = await exportPublicKeyB64(keyPair.publicKey);
    var challenge = REGISTRATION_PREFIX + publicKeyB64;
    var sig = new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(challenge)));
    var res = await fetch(API_BASE + "/identities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: publicKeyB64, registrationSignature: bytesToBase64(sig) }),
    });
    var json = await res.json();
    if (!res.ok) throw new Error(json.message || "Registration failed.");
    return json;
  }

  async function lookupIdentityByPublicKey(publicKeyB64) {
    var res = await fetch(API_BASE + "/identities/lookup?publicKey=" + encodeURIComponent(publicKeyB64));
    if (res.status === 404) return null;
    var json = await res.json();
    if (!res.ok) throw new Error(json.message || "Identity lookup failed.");
    return json;
  }

  /* ---------------- recovery: real Shamir shares of the private seed ---------------- */

  var RECOVERY_PREFIX = "ATLAS-RK-";
  var RECOVERY_THRESHOLD = 3;
  var RECOVERY_SHARE_COUNT = 5;

  function formatRecoveryKey(index, shareBytes32, publicKeyBytes32) {
    var payload = new Uint8Array(1 + 32 + 32);
    payload[0] = index;
    payload.set(shareBytes32, 1);
    payload.set(publicKeyBytes32, 33);
    var b64 = bytesToBase64(payload);
    // Grouped in 6-char blocks purely for readability when copied/retyped —
    // decoding strips the dashes right back out.
    var grouped = b64.match(/.{1,6}/g).join("-");
    return RECOVERY_PREFIX + grouped;
  }

  function parseRecoveryKey(str) {
    var trimmed = str.trim();
    if (trimmed.indexOf(RECOVERY_PREFIX) !== 0) {
      throw new Error("Not an Atlas recovery key (missing " + RECOVERY_PREFIX + " prefix).");
    }
    var b64 = trimmed.slice(RECOVERY_PREFIX.length).replace(/-/g, "");
    var payload = base64ToBytes(b64);
    if (payload.length !== 65) throw new Error("Malformed recovery key (wrong length).");
    return { x: payload[0], y: payload.slice(1, 33), publicKey: payload.slice(33, 65) };
  }

  /** Generates real 3-of-5 Shamir shares of this identity's actual private
   * key seed. Any 3 of the 5 strings returned fully reconstruct the private
   * key (see web/shamir.js); fewer than 3 reveal nothing about it. */
  async function makeRecoveryKeys(keyPair) {
    var seed = await exportSeed(keyPair.privateKey);
    var publicKeyBytes = await exportPublicKeyBytes(keyPair.publicKey);
    var shares = Shamir.split(seed, RECOVERY_SHARE_COUNT, RECOVERY_THRESHOLD);
    return shares.map(function (s) { return formatRecoveryKey(s.x, s.y, publicKeyBytes); });
  }

  /** Reconstructs a real, usable keypair from >= 3 recovery-key strings,
   * then looks up which server-side identity it belongs to (public keys
   * aren't secret, so that lookup needs no auth of its own — see
   * /identities/lookup). Throws if fewer than 3 valid keys are given, if
   * they don't parse, or if no identity was ever registered for the
   * resulting public key. */
  async function recoverIdentity(recoveryKeyStrings) {
    var parsed = recoveryKeyStrings.filter(function (s) { return s && s.trim(); }).map(parseRecoveryKey);
    if (parsed.length < RECOVERY_THRESHOLD) {
      throw new Error("Enter at least " + RECOVERY_THRESHOLD + " recovery keys.");
    }
    var publicKeyBytes = parsed[0].publicKey;
    var shares = parsed.slice(0, RECOVERY_THRESHOLD).map(function (p) { return { x: p.x, y: p.y }; });
    var seed = Shamir.combine(shares);
    var keyPair = await importKeyPairFromSeed(seed, publicKeyBytes);
    var publicKeyB64 = bytesToBase64(publicKeyBytes);
    var identity = await lookupIdentityByPublicKey(publicKeyB64);
    if (!identity) {
      throw new Error("These recovery keys are valid but no identity is registered for them.");
    }
    return { keyPair: keyPair, identity: identity };
  }

  /* ---------------- signed requests ---------------- */

  async function signedRequest(session, method, path, bodyObj) {
    var bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : "";
    var timestampMs = Date.now();
    var bodyHash = await sha256Hex(bodyStr);
    var canonical = [method.toUpperCase(), path, String(timestampMs), bodyHash].join("\n");
    var sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", session.privateKey, new TextEncoder().encode(canonical)),
    );
    var res = await fetch(API_BASE + path, {
      method: method,
      headers: {
        "content-type": "application/json",
        "x-atlas-identity": session.identityId,
        "x-atlas-timestamp": String(timestampMs),
        "x-atlas-signature": bytesToBase64(sig),
      },
      body: bodyObj !== undefined ? bodyStr : undefined,
    });
    var json = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((json && json.message) || "Request to " + path + " failed (" + res.status + ").");
    return json;
  }

  /* ---------------- convenience wrappers matching each backend route ---------------- */

  function connectFundingSource(session, args) {
    return signedRequest(session, "POST", "/funding-sources", args);
  }
  function revokeFundingSource(session, id) {
    return signedRequest(session, "POST", "/funding-sources/" + id + "/revoke");
  }
  function createGrant(session, args) {
    return signedRequest(session, "POST", "/permission-grants", args);
  }
  function revokeGrant(session, id) {
    return signedRequest(session, "POST", "/permission-grants/" + id + "/revoke");
  }
  function purchase(session, args) {
    return signedRequest(session, "POST", "/settlements/card-crypto-purchase", args);
  }
  function releaseSettlement(session, id) {
    return signedRequest(session, "POST", "/settlements/" + id + "/release");
  }
  function reverseSettlement(session, id, cryptoAsset) {
    return signedRequest(session, "POST", "/settlements/" + id + "/reverse", { cryptoAsset: cryptoAsset });
  }
  function getBalance(session, asset) {
    return signedRequest(session, "GET", "/identities/" + session.identityId + "/balance/" + asset);
  }
  function listFundingSources(session) {
    return signedRequest(session, "GET", "/identities/" + session.identityId + "/funding-sources");
  }
  async function getRate(cryptoAsset, fiatAsset) {
    var res = await fetch(API_BASE + "/rates/" + cryptoAsset + "/" + fiatAsset);
    var json = await res.json();
    if (!res.ok) throw new Error(json.message || "Rate lookup failed.");
    return json;
  }

  global.AtlasAPI = {
    API_BASE: API_BASE,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    generateKeyPair: generateKeyPair,
    exportPublicKeyB64: exportPublicKeyB64,
    exportPublicKeyBytes: exportPublicKeyBytes,
    exportSeed: exportSeedPublic,
    importKeyPairFromSeed: importKeyPairFromSeed,
    registerIdentity: registerIdentity,
    lookupIdentityByPublicKey: lookupIdentityByPublicKey,
    makeRecoveryKeys: makeRecoveryKeys,
    recoverIdentity: recoverIdentity,
    recoveryThreshold: RECOVERY_THRESHOLD,
    recoveryShareCount: RECOVERY_SHARE_COUNT,
    connectFundingSource: connectFundingSource,
    revokeFundingSource: revokeFundingSource,
    listFundingSources: listFundingSources,
    createGrant: createGrant,
    revokeGrant: revokeGrant,
    purchase: purchase,
    releaseSettlement: releaseSettlement,
    reverseSettlement: reverseSettlement,
    getBalance: getBalance,
    getRate: getRate,
  };
})(window);
