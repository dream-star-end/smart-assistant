// Private test launcher: exercise the real CLI's --assistant activation path.
// No runtime state setters, timer overrides, receipt ownership or SDK stubs.
process.argv.push('--assistant');
await import('../../../../../claude-code-best/scripts/dev.js');
