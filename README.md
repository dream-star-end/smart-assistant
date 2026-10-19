# OCV5-523 retry UI evidence

Real App + Chromium with controlled upstream/error fixtures; not live Box validation. Before reproduces old red-card behavior by selective ablation; after shows recovery busy state and terminal red cards. Account/model labels are test data.

Core15 retry source is unchanged in personal7a4efbcb86755dadd6f9f561b87d6cd0cf1d351b and commercial1b718b6a0629d0244581bd798431c4fb85e8cf30. source-proof.json records full21-path equivalence and unchanged edition differences. Images prove functional UI behavior, not a production-build benchmark or real Box/cache/billing result.

Personal PR884; commercial PR885. Personal real Box was aborted before requests because standard entry cannot reliably prohibit internal cc1 fallback. User permits replay/unit/PG/browser substitute; commercial separate real Box is waived on identical-code proof. CI/release state belongs to the PRs and handoff, not this immutable image set.
