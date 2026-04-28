/**
 * Normalize a bash command for `run_in_background:true`.
 *
 * Models (especially Sonnet) frequently append a shell `&` to commands while
 * also setting `run_in_background:true`. The shell `&` causes the parent bash
 * to fork the actual work into a child shell and then exit immediately. Once
 * the parent exits, BashTool's `detachTail` stops the TaskOutput poller, the
 * disowned grandchild's stdout is written to the task output file but never
 * polled, and the SDK never emits any `bash_output_tail` events. The web
 * client then sees only the "Command running in background…" placeholder and
 * no live tail.
 *
 * `run_in_background:true` already daemonizes via spawnShellTask, so the
 * trailing shell `&` is 100% redundant. Strip it before exec.
 *
 * Conservatism: only strip when there's at least one whitespace before the
 * trailing `&` (e.g. `done &`, `cmd 2>&1 &`). This intentionally does NOT
 * cover the compact form `cmd&` (no space), in order to stay safe against
 * unusual shell tokens that could end with `&` adjacent to a non-whitespace
 * character. Documented as a known limitation.
 */
export function normalizeBackgroundCommand(
  command: string,
  runInBackground: boolean | undefined,
): string {
  if (runInBackground !== true) return command
  return command.replace(/\s+&\s*$/, '')
}

/**
 * Apply {@link normalizeBackgroundCommand} to a BashTool input shape.
 *
 * Used at every method entry (checkPermissions, isReadOnly,
 * preparePermissionMatcher, toAutoClassifierInput, shouldUseSandbox call
 * sites, runShellCommand) so the same string used for security/sandbox
 * decisions is the one actually executed. Without this, the framework would
 * check `cmd &` while exec runs `cmd` — a "check what you run" violation
 * even if the practical delta is null (the trailing `&` operator does not
 * change the parsed argv that permission/sandbox logic inspects).
 */
export function normalizeBashInput<
  T extends { command: string; run_in_background?: boolean },
>(input: T): T {
  const command = normalizeBackgroundCommand(
    input.command,
    input.run_in_background,
  )
  if (command === input.command) return input
  return { ...input, command }
}
