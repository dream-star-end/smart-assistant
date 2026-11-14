-- OCV5-752: Drop legacy manual trigger on public.request_finalize_journal that was
-- created out-of-band on live PG prior to 3a4aba64d. That trigger overwrote
-- precheck_credits with the admission-time spendable balance (~2.1M), causing
-- internalDelegateAntigravityRoute (max(spendable, precheckCredits)) to fall back
-- to the stale admission balance when live balance dropped to 0, and creating
-- schema drift against fresh/test databases.
DROP TRIGGER IF EXISTS trg_rfj_delegate_antigravity_budget ON public.request_finalize_journal;
DROP FUNCTION IF EXISTS public.trg_rfj_delegate_antigravity_budget();
