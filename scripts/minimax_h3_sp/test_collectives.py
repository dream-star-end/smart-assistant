"""Two-rank correctness test for H3 uneven sequence/head transposes."""

import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import torch
import torch.distributed as dist
import torch.nn.functional as F

from comfy.ldm.minimax.sequence_parallel import MiniMaxH3SequenceParallel


rank = int(os.environ["LOCAL_RANK"])
torch.cuda.set_device(rank)
dist.init_process_group("nccl", device_id=torch.device(f"cuda:{rank}"))

options = {
    "minimax_h3_sp_job_digest": hashlib.sha256(b"collective-test").hexdigest(),
    "minimax_h3_sp_seed": 7,
}
runtime = MiniMaxH3SequenceParallel(options)
device = torch.device(f"cuda:{rank}")

sequence = 11
heads = 4
dim = 8
hidden = torch.arange(sequence * 16, device=device, dtype=torch.float32).view(sequence, 16)
rope = torch.arange(sequence * 4, device=device, dtype=torch.float32).view(1, sequence, 1, 1, 2, 2)
segments = [(0, 3, 0), (3, 8, 1), (8, 11, 2)]
local_hidden, local_rope, local_segments, context = runtime.shard(hidden, rope, segments, heads)
assert torch.equal(local_hidden, hidden[context.start:context.stop])
assert torch.equal(local_rope, rope[:, context.start:context.stop])
assert sum(stop - start for start, stop, _ in local_segments) == context.local_length
assert torch.equal(context.gather_sequence(local_hidden), hidden)

generator = torch.Generator(device=device).manual_seed(123)
q = torch.randn(sequence, heads, dim, generator=generator, device=device, dtype=torch.float32)
k = torch.randn(sequence, heads, dim, generator=generator, device=device, dtype=torch.float32)
v = torch.randn(sequence, heads, dim, generator=generator, device=device, dtype=torch.float32)
q_local = q[context.start:context.stop].contiguous()
k_local = k[context.start:context.stop].contiguous()
v_local = v[context.start:context.stop].contiguous()

q_heads = context.sequence_to_heads(q_local)
k_heads = context.sequence_to_heads(k_local)
v_heads = context.sequence_to_heads(v_local)
parallel = F.scaled_dot_product_attention(
    q_heads.transpose(0, 1).unsqueeze(0),
    k_heads.transpose(0, 1).unsqueeze(0),
    v_heads.transpose(0, 1).unsqueeze(0),
).squeeze(0).transpose(0, 1)
parallel_local = context.heads_to_sequence(parallel)

reference = F.scaled_dot_product_attention(
    q.transpose(0, 1).unsqueeze(0),
    k.transpose(0, 1).unsqueeze(0),
    v.transpose(0, 1).unsqueeze(0),
).squeeze(0).transpose(0, 1)
torch.testing.assert_close(parallel_local, reference[context.start:context.stop], rtol=1e-5, atol=1e-5)

flags = [torch.empty(1, device=device, dtype=torch.int32) for _ in range(2)]
dist.all_gather(flags, torch.ones(1, device=device, dtype=torch.int32))
if rank == 0:
    print({"sequence_splits": context.sequence_splits, "attention_match": True, "rank_flags": [int(x) for x in flags]})
dist.destroy_process_group()
