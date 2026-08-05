---
name: h3-video
description: Generate durable MiniMax H3 clips and assemble minute-scale storyboard video projects.
---

# H3 video generation

Use `oc-h3` for one 5, 10, or 15 second shot. The command queues a durable job and returns immediately:

```bash
oc-h3 generate --prompt '...' --duration 5 --aspect 16:9 \
  --first-frame first.png --last-frame last.png --reference person.png
```

- `--reference` may be repeated for identity/style references.
- First and last frames can be combined with references.
- Do not keep an Agent turn blocked while a normal generation runs. Return the job ID, tell the user it is queued, and use `oc-h3 status JOB_ID` when asked.
- Use `--wait --out result.mp4` only when the user explicitly wants this turn to wait.
- Users can cancel with `oc-h3 cancel JOB_ID`; completed media can be retrieved with `oc-h3 download JOB_ID --out result.mp4`.

For a video longer than one model shot, first write a JSON storyboard and create a durable project:

```json
{
  "shots": [
    {"prompt": "Opening shot...", "durationSeconds": 10},
    {"prompt": "Continue the same subject...", "durationSeconds": 10}
  ]
}
```

```bash
oc-video create --title 'Project' --storyboard storyboard.json --reference character.png
oc-video status PROJECT_ID
oc-video edit PROJECT_ID --expected-rev REV --storyboard revised-storyboard.json
oc-video start PROJECT_ID --expected-rev REV
oc-video render PROJECT_ID --expected-rev REV
```

`create` saves a draft and does not consume GPU time. Show the storyboard to the user first. Use `edit` to replace the draft storyboard after user feedback, then call `start` only after approval. Shots then run sequentially. Each later shot is conditioned from the actual final frame of its frozen predecessor artifact. Regenerating an earlier shot rebinds undispatched descendants to the new continuity; already running or completed downstream work remains visible but becomes stale. Regenerate the affected shot or explicitly accept its old dependency before rendering. Project edits use `--expected-rev` so an Agent never overwrites newer user intent.
