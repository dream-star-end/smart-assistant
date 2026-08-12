import json
import tempfile
import unittest
from pathlib import Path

from scripts.minimax_h3_sp.coordinator import canonical_prompt


class ConditioningContractTest(unittest.TestCase):
    def prompt(self):
        return {
            "1": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
            "2": {"class_type": "BasicScheduler", "inputs": {"model": ["7", 0], "steps": 20}},
            "3": {"class_type": "BasicGuider", "inputs": {"model": ["7", 0]}},
            "4": {"class_type": "LoadImage", "inputs": {"image": "reference.png"}},
            "5": {"class_type": "LoadImage", "inputs": {"image": "first.png"}},
            "6": {
                "class_type": "MiniMaxH3ReferenceToVideo",
                "inputs": {
                    "clip": ["8", 0], "vae": ["9", 0], "audio_vae": ["10", 0],
                    "prompt": "subject", "width": 608, "height": 352, "length": 124,
                    "ref_images": {"ref_image_0": ["4", 0]}, "first_frame": ["5", 0],
                },
            },
            "7": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["11", 0]}},
            "12": {"class_type": "SaveVideo", "inputs": {"video": ["13", 0]}},
        }

    def test_rank1_prompt_drops_external_media_but_keeps_contract(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "prompt.json"
            path.write_text(json.dumps({"prompt": self.prompt()}))
            prompts, digest, seed = canonical_prompt(path, "job-1", "attempt-1")
        self.assertEqual(seed, 42)
        self.assertEqual(len(digest), 64)
        self.assertIn("ref_images", prompts[0]["6"]["inputs"])
        self.assertIn("first_frame", prompts[0]["6"]["inputs"])
        self.assertNotIn("ref_images", prompts[1]["6"]["inputs"])
        self.assertNotIn("first_frame", prompts[1]["6"]["inputs"])
        sp = next(node for node in prompts[0].values() if node["class_type"] == "MiniMaxH3SequenceParallel")
        self.assertEqual(sp["inputs"]["job_id"], "job-1")
        self.assertEqual(sp["inputs"]["attempt_id"], "attempt-1")
        self.assertEqual(sp["inputs"]["total_steps"], 20)

    def test_payload_manifest_preserves_keyframe_then_reference_latent_order(self):
        try:
            import torch
            from comfy.ldm.minimax.sequence_parallel import MiniMaxH3SequenceParallel
        except ModuleNotFoundError as exc:
            self.skipTest(f"H3 engine dependencies are unavailable: {exc}")
        keyframe = torch.zeros((1, 24, 2, 22, 38), dtype=torch.float16)
        reference = torch.ones((1, 24, 2, 16, 16), dtype=torch.float16)
        tags = torch.tensor([1, 0, 1], dtype=torch.long)
        manifest, tensors = MiniMaxH3SequenceParallel._payload_manifest({
            "seed": 42,
            "frame_count": 124,
            "text_token_tags": tags,
            "keyframes": [{"resolved_frame_index": 0, "latent": keyframe}],
            "refs": [{"kind": "image", "latent_h": 16, "latent_w": 16, "latent": reference}],
            "cond_video_latents": [keyframe, reference],
        })
        self.assertEqual(manifest["cond_video_latents"], [0, 1])
        self.assertEqual(manifest["text_token_tags"], 2)
        self.assertIs(tensors[0], keyframe)
        self.assertIs(tensors[1], reference)
        self.assertEqual(manifest["keyframes"], [{"resolved_frame_index": 0}])
        self.assertEqual(manifest["refs"], [{"kind": "image", "latent_h": 16, "latent_w": 16}])


if __name__ == "__main__":
    unittest.main()
