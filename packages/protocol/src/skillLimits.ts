/**
 * Skill-eval capacity limits — the single cross-layer authority.
 *
 * storage (`skillEvals.ts` schema validation), gateway (generation prompt) and
 * web-react (the eval-case editor UI) all derive their cap from HERE so the three
 * layers can never drift apart again. Historically storage enforced 8 while the web
 * editor hard-coded 5, so a skill that ended up with 6-8 cases (e.g. via a merged
 * training draft whose `skill_propose` evals passed at ≤8) rendered "8/5" and locked
 * the "add case" control (see docs/audit/msc-skills.md · S-03).
 *
 * Cost discipline (boss 红线): evals run a real model and spend user credits, so the
 * case cap is also the per-run cost ceiling — raising it raises spend.
 */

/** Max eval cases per skill (`evals/evals.json`). Cost ceiling = case ceiling. */
export const MAX_EVAL_CASES = 8
