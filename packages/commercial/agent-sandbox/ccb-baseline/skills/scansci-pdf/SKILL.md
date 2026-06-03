---
name: scansci-pdf
description: Use ScanSci PDF MCP tools to search academic papers, download PDFs by DOI/arXiv/title, batch-download reading lists, and produce citations for the user.
tags: [research, papers, pdf, citation]
---

# ScanSci PDF paper assistant

Use this skill when the user asks to find papers, download a paper PDF, batch download a reading list, resolve DOI/arXiv/title identifiers, check paper-source health, or generate citations.

## Default behavior

- Prefer `scansci_pdf_search` for vague topics, title fragments, or when multiple papers may match. Ask the user to choose before downloading many ambiguous results.
- Prefer `scansci_pdf_download` for a single DOI, arXiv ID, URL, or exact title. Save into the default ScanSci data directory unless the user asked for another path.
- Prefer `scansci_pdf_batch_download` for a user-provided DOI/arXiv/title list. Keep batches small unless the user explicitly asks for a large run.
- Use `scansci_pdf_citation` when the user asks for BibTeX, RIS, APA, MLA, Vancouver, or citation metadata.
- Use `scansci_pdf_health_check` or `scansci_pdf_network_diagnose` when downloads repeatedly fail.

## User-facing response rules

After a successful download, always include:

1. Paper title or identifier.
2. Source/status if the tool returns it.
3. The exact absolute PDF path, usually under `/home/agent/.local/share/scansci-pdf/papers/`.
4. Citation/BibTeX if the user asked for it or if it helps the task.

Keep replies concise and actionable. If a PDF path is available, print the path directly so OpenClaude can render it as a file card.

## Safety and privacy

- Do not reveal ScanSci config, API keys, cookies, browser state, access tokens, or proxy credentials.
- Do not call raw config-dump tools such as `scansci_pdf_config_get`; commercial UI intentionally hides config-tool output.
- Do not print the contents of files such as `config.json`, `browser_state.json`, cookie files, or token files.
- Prefer legal/open-access routes when the user has not specified an access strategy.
- If the user asks for institutional/WebVPN/CARSI login or "隐身浏览器", explain that this commercial runtime currently exposes ScanSci core download/search/citation tools and status checks; interactive remote browser login requires a separately enabled isolated browser sidecar.

## Useful tool mapping

- Search: `scansci_pdf_search(query, limit, year_from?, year_to?, sort?)`
- Single download: `scansci_pdf_download(identifier, output_dir?, scihub_enabled?, use_tor, use_vpnsci, bibtex, strategy)`
- Batch download: `scansci_pdf_batch_download(identifiers, output_dir?, scihub_enabled?, use_tor, use_vpnsci, batch_id?, resume)`
- Citation: `scansci_pdf_citation(identifier, format)`
- Health: `scansci_pdf_health_check(detailed)` / `scansci_pdf_network_diagnose()` / `scansci_pdf_source_scores()`
- WebVPN status: `scansci_pdf_vpnsci_status()` / `scansci_pdf_vpnsci_schools(query)` / `scansci_pdf_vpnsci_test(doi?)`
