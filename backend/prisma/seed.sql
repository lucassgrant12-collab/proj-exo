-- Reference data: the assets the ledger knows about. Must match
-- src/domain/money.ts's ASSETS table exactly — decimals here is the source
-- of truth the app reads at runtime, so a mismatch is a real bug, not a
-- cosmetic one. Run this once after the init migration, and again any time
-- an asset is added to money.ts.

INSERT INTO "assets" ("code", "decimals", "kind") VALUES
  ('GBP',  2,  'FIAT'::"AssetKind"),
  ('USD',  2,  'FIAT'::"AssetKind"),
  ('BTC',  8,  'CRYPTO'::"AssetKind"),
  ('ETH',  18, 'CRYPTO'::"AssetKind"),
  ('USDC', 6,  'CRYPTO'::"AssetKind")
ON CONFLICT ("code") DO UPDATE SET
  "decimals" = EXCLUDED."decimals",
  "kind" = EXCLUDED."kind";
