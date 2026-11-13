Frozen test sources from dream-star-end/smart-assistant at9826fe9512f6c2e2a9479d2db7faa55dd4515ac2.

The three `.mjs.txt` data files are exact historical bytes, independently matched against the sealed running baseline. Tests check their hashes and stage them under their original `.mjs` names; the historical sources are not rewritten to match current lint rules. The browser fixture supplies the unchanged shared browser helpers from the current test tree and synthetic localhost responses; no live login or model call is made.

SHA256:

- scripts/lib/user-contract.mjs:5ca7dc45dbf863706589fda68024b8ef254b954aa20a0fb60b839ec6576fbabf
- scripts/v5-user-contract-prewarm.mjs:ca71903e8e8a048caa7db16c03186e63d2d7e70afecc8b017778c2e26b5b0b9c
- scripts/v5-user-contract-smoke.mjs:ad292d858bbf0dd28421af61d96c6ce65c2d5f78dd309a1c42c3cdfe9afa09f6
