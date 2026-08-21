# Operator split

Opus 只管理规划与验收，不亲自改代码。执行交给 Grok：Grok executes implementation work, writes patches, and runs the local checks. When a task says "先设计再落地", Opus manages the plan and Grok executes the diff.

- Planning owner: Opus
- Implementation owner: Grok
- Reviewer may be either, but the default is Opus manages / Grok executes
- Do not ask Opus to apply mechanical edits; hand those to Grok
- English shorthand: Opus manages, Grok executes

This is a standing preference, not a one-off. If a session forgets the split, restore it from this profile rather than inventing a new workflow.
