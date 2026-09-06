Testdata-only TLS fixtures for desktop Host tests.

Private keys (`*.key`) are generated at test start by `generate.mjs` (openssl)
and are gitignored. This is a test CA (`CN=oc-desktop-test-ca`), not the
production device CA. Do not copy these files into the installer.
