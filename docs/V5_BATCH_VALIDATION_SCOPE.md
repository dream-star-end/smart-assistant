# Per-batch commercial validation scope

The default remains the complete Grok + DeepSeek turn matrix and Grok J1–J5 journey.
An explicitly authorized release may use `--validation-profile=skip-grok` together
with `--validation-authorization-ref=<traceable approval reference>` on ordinary
`--with-dist` deployment. The official detached wrapper forwards these CLI arguments.
This is not an account, quota, provider fallback, or global environment switch.

The profile binds the real active queue, pinned source and mutation deployment ID.
It retains the full DeepSeek true-turn checks, live cost evidence and all J1–J5
browser assertions, using the existing DeepSeek model for the entire journey.
Grok matrix/journey results are explicitly SKIPPED, never reported as passed.
Unknown profiles, missing authorization, conflicting model overrides or other gate
waivers fail closed. CI, artifact/static CLI compatibility, live idle, fencing,
compensation, health, assets/dist/public surface, egress and plugin gates still run.

The operation receipt is persisted under `.validation-scopes` on the release host.
The existing durable gate debt mechanism records `grok-live-validation`; monitoring
continues to expose the resulting warning. A subsequent release cannot silently
repeat the exclusion. Only a complete successful Grok matrix AND Grok journey can
clear this debt. Partial scope results cannot repay existing complete-gate debts.

Optional typed-policy operations include the non-default scope in their descriptor
and digest. Recovery inherits that saved scope, including its original owner/source
binding; a new invocation cannot replace it through the environment. Legacy normal
records retain their original shape and digest. Safe compensation remains available.

After publication, report the exact deployed SHA and the excluded Grok live checks.
Do not claim complete engine validation or alter quota, credentials, disabled accounts,
or prior failure evidence. Each new exclusion requires its own explicit authorization.
