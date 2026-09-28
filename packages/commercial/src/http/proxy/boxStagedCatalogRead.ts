/** Read only the catalog staged for one already admitted nonce.
 * The caller cannot choose a path. This does not execute tools or launch a CLI. */
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxExecTransport } from "./boxExecTransport.js";

const READ_CATALOG = String.raw`import os,re,stat,sys
nonce=sys.argv[1]
if not re.fullmatch(r'[0-9a-f]{24}',nonce):raise SystemExit(1)
path='/tmp/ocv5-289-run-'+nonce
directory=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(directory)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(1)
 fd=os.open('tool-catalog.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or not 1<=st.st_size<=1048576:raise SystemExit(1)
  raw=os.read(fd,st.st_size+1)
  again=os.fstat(fd)
  if len(raw)!=st.st_size or again.st_size!=st.st_size:raise SystemExit(1)
  raw.decode('utf-8')
  os.write(1,raw)
 finally:os.close(fd)
finally:os.close(directory)`;

export class BoxStagedCatalogReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxStagedCatalogReadError"; }
}

export function makeBoxStagedCatalogRead(runNonce: string): BoxCcExecRequest {
  if (!/^[0-9a-f]{24}$/.test(runNonce)) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_NONCE_INVALID");
  }
  return { command: "/usr/bin/python3", args: ["-I", "-c", READ_CATALOG, runNonce],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}

export async function readBoxStagedToolCatalog(input: {
  exec: Pick<BoxExecTransport, "run">;
  runNonce: string;
  signal?: AbortSignal;
}): Promise<{ json: string }> {
  const request = makeBoxStagedCatalogRead(input.runNonce);
  const result = await input.exec.run(request, {
    timeoutMs: 5_000, maxResponseBytes: 1_048_576, signal: input.signal });
  const json = result.stdout;
  if (json.length < 1 || Buffer.byteLength(json) > 1_048_576) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  return { json };
}
