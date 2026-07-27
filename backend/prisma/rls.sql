-- Enables Row Level Security on every table, with no policies defined.
--
-- Supabase automatically exposes every table in the public schema through
-- its own REST/GraphQL API (PostgREST) to anyone holding the project's
-- anon key — entirely separate from, and bypassing, this project's own
-- Fastify backend and its signature-based auth (see authMiddleware.ts).
--
-- This backend connects to Postgres directly via DATABASE_URL as the
-- owning/service role, which is exempt from RLS by default, so none of
-- this affects how Prisma reads or writes anything. What it does is lock
-- Supabase's own auto-generated API out of every table entirely: with RLS
-- enabled and zero policies created, every non-owner role (including
-- `anon` and `authenticated`) gets zero rows, by default, from every table
-- below. Run this once, after the init migration.

ALTER TABLE "identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "funding_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permission_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issuer_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spend_token_issuances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "redeemed_spend_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlement_records" ENABLE ROW LEVEL SECURITY;
