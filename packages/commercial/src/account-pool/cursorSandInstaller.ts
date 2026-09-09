import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sandHash } from "./cursorSandState.js";

/** Public source bytes only. Never embed account/gateway/inference credentials in a Bot prompt. */
export function loadCursorSandInstaller() {
  const installer = readFileSync(fileURLToPath(new URL("../../../../scripts/cursor-sand-box-relay/installer.py", import.meta.url)));
  const module = readFileSync(fileURLToPath(new URL("../../../../scripts/cursor-sand-box-relay/relay.cjs", import.meta.url)));
  const moduleHash = sandHash(module.toString("utf8")), installerHash = sandHash(installer.toString("utf8"));
  if (installer.length + module.length > 128 * 1024) throw new Error("SAND_INSTALLER_TOO_LARGE");
  return {
    moduleHash,
    prompt: (args: { nonce: string; hostPid: number; agentId: string; moduleHash: string }): string => {
      if (!/^oc-sand-[a-f0-9]{32}$/.test(args.nonce) || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.agentId) || !Number.isSafeInteger(args.hostPid) || args.hostPid <= 1 || args.moduleHash !== moduleHash) throw new Error("SAND_INSTALL_ARGUMENT_INVALID");
      const payload = { nonce: args.nonce, agentId: args.agentId, expectedPid: args.hostPid, moduleSha256: moduleHash, moduleBase64: module.toString("base64") };
      return `The owner authorized automatic Sand inference-only relay preparation. Run ONLY the exact checked script below once. Do not generate or alter patch code, read credentials/env/process memory, upgrade the host, signal/restart/pause any process, create another Bot, delete data, or send inference probes. The parent observed host PID ${args.hostPid}. The script checks metadata/source/backups/syntax and stages compatible files. ONLY a proven new Box without an old relay may receive a fixed-ID native restart command; the native supervisor waits until ALL Bots are idle. An old relay or unknown supervisor only awaits natural restart, since native health does not cover its streams. Do not force a restart, delete commands/intents, or retry to make it work. Report the exact public JSON receipt and END THIS TURN NORMALLY so native idle detection can proceed. Do not claim recovery; the parent verifies actual capability.
\npython3 - <<'OC_SAND_INSTALL'
import base64,hashlib,json,pathlib,subprocess,os
data=base64.b64decode(${JSON.stringify(installer.toString("base64"))},validate=True)
assert hashlib.sha256(data).hexdigest()==${JSON.stringify(installerHash)},'installer hash mismatch'
p=pathlib.Path('/home/box/sand-host/.installer-${args.nonce}.py')
if p.exists():
 assert not p.is_symlink() and p.read_bytes()==data,'existing installer mismatch'
else:
 with p.open('xb') as f:
  os.chmod(p,0o600);f.write(data);f.flush();os.fsync(f.fileno())
payload=json.loads(${JSON.stringify(JSON.stringify(payload))})
result=subprocess.run(['python3',str(p),'--apply'],input=json.dumps(payload).encode())
raise SystemExit(result.returncode)
OC_SAND_INSTALL`;
    },
  };
}
