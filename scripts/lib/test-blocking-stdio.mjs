// Preloaded into `node --test --test-force-exit` runs (see package.json).
//
// The runner starts one child per test file and the child reports over its
// stdout pipe. On POSIX a pipe write is asynchronous, and --test-force-exit
// makes the child call process.exit() as soon as its tests are done, so
// whatever is still queued is lost. The parent then counts a file with its
// last suites missing and still exits 0 (2026-10-04: three unit gate runs on
// one tree reported 7011, 7027 and 7007 tests; a failure in a dropped tail
// would not have been seen). Blocking writes leave nothing queued at exit.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);
