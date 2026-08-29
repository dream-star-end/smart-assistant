"""Rank-aware ComfyUI launcher for the two-card MiniMax H3 worker."""

import atexit
import os
import runpy
import sys
from datetime import timedelta
from pathlib import Path


rank = int(os.environ["LOCAL_RANK"])
os.environ["HIP_VISIBLE_DEVICES"] = str(rank)
os.environ.pop("ROCR_VISIBLE_DEVICES", None)
os.environ.pop("CUDA_VISIBLE_DEVICES", None)

import torch
import torch.distributed as dist


torch.cuda.set_device(0)
dist.init_process_group(
    "nccl",
    timeout=timedelta(seconds=int(os.environ.get("H3_SP_COLLECTIVE_TIMEOUT_SECONDS", "120"))),
    device_id=torch.device("cuda:0"),
)
if torch.cuda.device_count() != 1:
    raise RuntimeError(f"rank {rank} must see exactly one device, got {torch.cuda.device_count()}")
props = torch.cuda.get_device_properties(0)
bdf = f"{props.pci_domain_id:04x}:{props.pci_bus_id:02x}:{props.pci_device_id:02x}.0"
print(
    f"H3_SP_RANK_READY rank={rank} physical_device={os.environ['HIP_VISIBLE_DEVICES']} "
    f"bdf={bdf} local_device={torch.cuda.get_device_name(0)} count={torch.cuda.device_count()}",
    flush=True,
)
atexit.register(lambda: dist.destroy_process_group() if dist.is_initialized() else None)

_tv_lib = None
try:
    torch.ops.torchvision.nms
except (AttributeError, RuntimeError):
    _tv_lib = torch.library.Library("torchvision", "DEF")
    _tv_lib.define("nms(Tensor dets, Tensor scores, float iou_threshold) -> Tensor")

root = Path(os.environ["H3_SP_WORKTREE"])
state = Path(os.environ["H3_SP_STATE_ROOT"]) / f"rank{rank}"
for name in ("input", "output", "temp", "user", "cache", "home", "custom_nodes", "models"):
    (state / name).mkdir(parents=True, exist_ok=True)
(state / "user" / "default").mkdir(parents=True, exist_ok=True)
os.environ["HOME"] = str(state / "home")
os.environ["XDG_CACHE_HOME"] = str(state / "cache")
os.environ["TMPDIR"] = str(state / "temp")

port = int(os.environ.get("H3_SP_BASE_PORT", "8290")) + rank
sys.path.insert(0, str(root))
sys.argv = [
    str(root / "main.py"),
    "--listen", "127.0.0.1",
    "--port", str(port),
    "--base-directory", str(state),
    "--input-directory", str(state / "input"),
    "--output-directory", str(state / "output"),
    "--temp-directory", str(state / "temp"),
    "--user-directory", str(state / "user"),
    "--database-url", f"sqlite:///{state / 'user' / 'comfyui.db'}",
    "--extra-model-paths-config", os.environ["H3_SP_MODEL_PATHS"],
    "--disable-auto-launch",
    "--disable-metadata",
    "--disable-triton-backend",
    "--disable-xformers",
    "--gpu-only",
    "--disable-async-offload",
    "--log-stdout",
]
runpy.run_path(str(root / "main.py"), run_name="__main__")
