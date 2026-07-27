-- CreateEnum
CREATE TYPE "FundingSourceKind" AS ENUM ('BANK', 'CARD', 'WALLET');

-- CreateEnum
CREATE TYPE "FundingRail" AS ENUM ('PISP', 'CARD_NETWORK', 'ONCHAIN');

-- CreateEnum
CREATE TYPE "FundingSourceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "PermissionGrantStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SpendTokenForm" AS ENUM ('VIRTUAL_CARD', 'CRYPTO_ADDRESS');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('FIAT', 'CRYPTO');

-- CreateEnum
CREATE TYPE "LedgerAccountOwnerType" AS ENUM ('IDENTITY', 'ATLAS_OPERATING', 'ATLAS_CUSTODY_POOL', 'EXTERNAL_FUNDING', 'EXTERNAL_LIQUIDITY');

-- CreateEnum
CREATE TYPE "LedgerTransactionKind" AS ENUM ('FUNDING_RECEIVED', 'LIQUIDITY_PURCHASE', 'POSITION_ALLOCATION', 'MERCHANT_SPEND', 'CHARGEBACK_REVERSAL', 'HOLD_UNWIND', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'HELD', 'RELEASED', 'REVERSED');

-- CreateTable
CREATE TABLE "identities" (
    "id" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "publicKeyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_sources" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "kind" "FundingSourceKind" NOT NULL,
    "rail" "FundingRail" NOT NULL,
    "label" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "status" "FundingSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_grants" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "fundingSourceId" TEXT NOT NULL,
    "limitMinor" BIGINT NOT NULL,
    "limitAsset" TEXT NOT NULL,
    "windowSeconds" INTEGER NOT NULL,
    "singleUse" BOOLEAN NOT NULL DEFAULT false,
    "merchantCategory" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" "PermissionGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issuer_keys" (
    "id" TEXT NOT NULL,
    "modulusN" TEXT NOT NULL,
    "exponentE" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "issuer_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spend_token_issuances" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "form" "SpendTokenForm" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "amountAsset" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spend_token_issuances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redeemed_spend_tokens" (
    "tokenHash" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amountMinor" BIGINT NOT NULL,
    "amountAsset" TEXT NOT NULL,

    CONSTRAINT "redeemed_spend_tokens_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "assets" (
    "code" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "kind" "AssetKind" NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "ownerType" "LedgerAccountOwnerType" NOT NULL,
    "ownerId" TEXT,
    "assetCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" TEXT NOT NULL,
    "kind" "LedgerTransactionKind" NOT NULL,
    "memo" TEXT NOT NULL,
    "settlementRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_records" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "fundingChargeRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "amountAsset" TEXT NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "heldUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identities_displayId_key" ON "identities"("displayId");

-- CreateIndex
CREATE UNIQUE INDEX "identities_publicKey_key" ON "identities"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "identities_publicKeyFingerprint_key" ON "identities"("publicKeyFingerprint");

-- CreateIndex
CREATE INDEX "funding_sources_identityId_idx" ON "funding_sources"("identityId");

-- CreateIndex
CREATE INDEX "permission_grants_identityId_idx" ON "permission_grants"("identityId");

-- CreateIndex
CREATE INDEX "permission_grants_fundingSourceId_idx" ON "permission_grants"("fundingSourceId");

-- CreateIndex
CREATE INDEX "spend_token_issuances_grantId_idx" ON "spend_token_issuances"("grantId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_ownerType_ownerId_assetCode_key" ON "ledger_accounts"("ownerType", "ownerId", "assetCode");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- CreateIndex
CREATE INDEX "ledger_entries_accountId_idx" ON "ledger_entries"("accountId");

-- CreateIndex
CREATE INDEX "settlement_records_grantId_idx" ON "settlement_records"("grantId");

-- AddForeignKey
ALTER TABLE "funding_sources" ADD CONSTRAINT "funding_sources_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_fundingSourceId_fkey" FOREIGN KEY ("fundingSourceId") REFERENCES "funding_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spend_token_issuances" ADD CONSTRAINT "spend_token_issuances_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "permission_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_settlementRecordId_fkey" FOREIGN KEY ("settlementRecordId") REFERENCES "settlement_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_records" ADD CONSTRAINT "settlement_records_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "permission_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

