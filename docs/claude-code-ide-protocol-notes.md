# Claude Code IDE protocol notes

_Last checked: 2026-06-11._

This note records the current feasibility findings for OpenClaude's official Claude Code terminal entry. It is intentionally a research note, not a supported IDE adapter spec.

## Runtime vs local source reference

- Production launches the official `claude` interactive CLI through a server PTY.
- The installed CLI at `/root/.local/share/claude/versions/2.1.172` is a native ELF binary.
- The repository also contains `claude-code-best/`, which includes TypeScript sources and docs, but its package version is `1.0.3`. Treat it as protocol reference material, not as the exact source for the installed 2.1.172 runtime.

## What IDE integration appears to do

From `claude-code-best`:

- IDE extensions/plugins write lockfiles under `~/.claude/ide/*.lock`.
- Lockfile JSON can include `workspaceFolders`, `pid`, `ideName`, `transport`, `runningInWindows`, and `authToken`.
- Claude Code discovers IDEs by reading these lockfiles and matching the current cwd to the IDE workspace.
- Supported internal MCP transport config types include `sse-ide` and `ws-ide`.
- For WebSocket IDE connections, Claude Code sends `X-Claude-Code-Ide-Authorization` when the lockfile provides an auth token.
- IDE feature RPC/notifications include examples such as `openDiff`, `close_tab`, `closeAllDiffTabs`, `selection_changed`, `file_updated`, and IDE diagnostics/code execution tools.

## Feasibility conclusion

IDE integration is primarily “Claude Code connects to a local IDE plugin MCP server for editor context and diff UX”. It is not a documented chat UI protocol and is not a replacement for Agent SDK / `claude -p`.

For OpenClaude personal edition, the safest subscription-preserving production path remains the interactive PTY terminal. Any future IDE-like adapter should be treated as a separate experiment and must keep the official interactive CLI path, not switch to SDK billing.

References:

- https://code.claude.com/docs/en/ide-integrations
- https://code.claude.com/docs/en/jetbrains
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
