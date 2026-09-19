#!/usr/bin/env python3
"""Package original, already-tested source works; --check compares actual hashes."""
import argparse, hashlib, json, pathlib, zipfile, io
root=pathlib.Path(__file__).resolve().parents[1]/"public/tutorials/showcase-works"
parser=argparse.ArgumentParser();parser.add_argument("--check",action="store_true");args=parser.parse_args()
def sha(b):return hashlib.sha256(b).hexdigest()
for wid in ["planet","gravity"]:
 p=root/wid
 names=["index.html"]+(["physics.js","physics.mjs"] if wid=="gravity" else [])
 # Stable zip metadata avoids rebuilding different bytes every run.
 stream=io.BytesIO()
 with zipfile.ZipFile(stream,"w",zipfile.ZIP_DEFLATED) as z:
  for name in names:
   info=zipfile.ZipInfo(name,date_time=(2026,9,8,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,(p/name).read_bytes())
 if args.check:assert (p/"source.zip").read_bytes()==stream.getvalue(),wid+" zip stale"
 else:(p/"source.zip").write_bytes(stream.getvalue())
 if wid=="gravity":
  expected="(()=>{\n"+(p/"physics.mjs").read_text().replace("export ","")+"\nwindow.GravityPhysics={initial,step,measure,DT,EPSILON};})();\n"
  assert (p/"physics.js").read_text()==expected,"classic sandbox bundle differs from tested module"
 files=[{"path":f"/tutorials/showcase-works/{wid}/{name}","bytes":len((p/name).read_bytes()),"sha256":sha((p/name).read_bytes())} for name in names+["source.zip","cover.png"]]
 manifest={"schema":1,"workId":wid,"kind":"original-interactive-code","authorship":"Created in OpenClaude for OCV5-172; not a third-party replay","rendering":"Browser-rendered cover, not an AI illustration","fullConversationReplay":False,"files":files,"sourceFiles":names,"limitations":("Procedural sphere shading and approximate atmosphere; no surface landing or observational data." if wid=="planet" else "2D softened Newtonian teaching model; dimensionless G=1; epsilon=.025; dt=.002 velocity Verlet; not collision or relativity simulation.")}
 if args.check:
  existing=json.loads((p/"manifest.json").read_text());assert existing==manifest,wid+" manifest stale"
 else:(p/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n")
 print("PASS",wid,"actual file hashes, stable source zip"+(", classic physics matches tested module" if wid=="gravity" else ""))
