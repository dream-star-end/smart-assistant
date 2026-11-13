# Antigravity 1.4.0 native schema projection

## Provenance and trust boundary

The source is the official Linux x64 CLI 1.4.0 embedded FileDescriptorProto,
not field numbers inferred from a database sample. Exact CLI SHA256:
`60e72242f07c131f75afcd9a9e425d6ee097a1a1b3190ea98ae78fa4180bbfa8`.
No version-string trust or environment bypass. `prepare` streams the binary hash
asynchronously and caches against realpath/dev/inode/size/mtimeNs/ctimeNs/mode;
`recover` verifies it again. Tests use an explicit injected verifier only.

The 2026-11-04 evidence archive is `antigravity-empty-schema-probes-20261104.zip`
(in platform generated artifacts), with `schema.json`, `schema_probe.py`, raw
trajectory/cortex/codeium descriptors, and read-only recovery evidence. The
projection was selected using the fields encountered in that evidence plus all
scalar fields of selected messages and safety-relevant tool identity fields.
Every retained field name, number, type, label, and full enum value set is copied
from the extracted official descriptors; **no prompt, thinking, tool argument,
or answer content appears in the schema**.

This is intentionally not a general importer: only USER_INPUT, PLANNER_RESPONSE,
and GENERIC are supported. Other step kinds or omitted fields, even if legitimate
for this pinned version, fail closed. Expanding the projection requires fresh
schema evidence and tests; do not replace omitted messages with guessed fields.
Protobuf Any values are descriptor-declared opaque bytes, never executed/unpacked.

## Descriptor byte ranges used by this projection

| Embedded file | Binary offset | Length | SHA256 |
|---|---:|---:|---|
| `google/protobuf/any.proto` | 220479920 | 223 | `865923ed32e4eca5ff0086a48b4eecacc00a5ce32f0534f6f5ccb25ab3fd5fd5` |
| `google/protobuf/duration.proto` | 92159166 | 254 | `d74f874b3dcc707fa971ad4ce7543ac7de5eec47836b70565eafc85296d2f00b` |
| `google/protobuf/timestamp.proto` | 92162240 | 258 | `677ffd2bf8f2b78cd407039ddf76d8033df80f0a885e23a793c99298b926895f` |
| `third_party/gemini_coder/proto/trajectory.proto` | 94829920 | 13709 | `b67f5b493317f52e15582ffd19e687c656afa52c30d591f418beebe280bddb93` |
| `third_party/jetski/chat_client_server_pb/chat_client_server.proto` | 92520570 | 1565 | `30fe0eeabaf4bf2401641c9cbed92b4ed3d3eacd32f54ce5a63c5c5cd7791228` |
| `third_party/jetski/codeium_common_pb/codeium_common.proto` | 98306955 | 185148 | `115bf3ad7cfc8fc9342a8f0127a186c0afc94ea54bde7dc0d811f467202d0c0f` |
| `third_party/jetski/context_module_pb/context_module.proto` | 93963734 | 6863 | `39ed340ed595cd88197b1f302e2647b1096c8e08af751995fe30f8b2d31e3708` |
| `third_party/jetski/cortex_pb/cortex.proto` | 98492103 | 205909 | `c17d3837afad769b69c673ce5cb181415ce35a1b897daa43bbe17cfe53f0fee2` |
| `third_party/jetski/hooks_pb/hooks.proto` | 93541027 | 4997 | `fef192006e30fc6fe9012bb6b105411ddae4abb5cfa96b374eed5892826f6b30` |

## Regeneration

1. Verify the binary hash above, extract its FileDescriptorProto with the archived
   probe, and resolve messages/enums in `schema.json`.
2. Retain the message fields listed below. Map protobuf descriptor scalar types
   to protobufjs scalar names, `label=3` to `rule: repeated`, fully qualified type
   names to aliases by replacing `.` with `_`. Copy referenced enums in full.
3. Preserve snake_case field names. Map entries stay repeated explicit entry
   messages; this projection does not coerce maps into JS dictionaries.
4. Emit a TypeScript `INamespace` constant `antigravityNativeSchema`; import with
   protobufjs `Root.fromJSON(...).resolveAll()`. No runtime schema file lookup.
5. Validate unknown fields/enums, duplicate singular fields, wire widths, bounded
   nested messages, strict UTF-8, and fully terminated varints before standard
   protobufjs decoding. In particular Reader.int32/uint32 truncate high bytes;
   using those alone as a strict verifier accepts corrupt DONE statuses.

### Retained message fields (official field numbers)

```json
{
  "gemini_coder.Step": [
    1,
    4,
    5,
    19,
    20,
    31,
    140
  ],
  "exa.cortex_pb.CortexStepMetadata": [
    1,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    14,
    15,
    17,
    18,
    19,
    20,
    21,
    23,
    26,
    27,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    38,
    39
  ],
  "google.protobuf.Timestamp": [
    1,
    2
  ],
  "exa.cortex_pb.SourceTrajectoryStepInfo": [
    1,
    2,
    3,
    4
  ],
  "exa.cortex_pb.CortexStepInternalMetadata": [
    1
  ],
  "exa.cortex_pb.StatusTransition": [
    1,
    2
  ],
  "exa.cortex_pb.CortexStepUserInput": [
    1,
    2,
    3,
    4,
    6,
    8,
    12,
    16,
    18
  ],
  "exa.codeium_common_pb.TextOrScopeItem": [
    1
  ],
  "exa.context_module_pb.ContextModuleResult": [],
  "exa.cortex_pb.CascadeConfig": [
    1,
    3,
    6,
    8,
    10,
    12
  ],
  "exa.cortex_pb.CascadePlannerConfig": [
    1,
    6,
    7,
    13,
    14,
    25,
    28,
    30,
    33,
    37,
    40,
    42,
    46,
    47,
    48,
    51,
    53,
    54,
    55,
    57,
    58,
    59
  ],
  "exa.cortex_pb.CascadeToolConfig": [
    8,
    16,
    29,
    42,
    43,
    46,
    49,
    50,
    51,
    53
  ],
  "exa.cortex_pb.RunCommandToolConfig": [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    23,
    24
  ],
  "exa.cortex_pb.AutoCommandConfig": [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9
  ],
  "exa.cortex_pb.McpToolConfig": [
    1,
    2,
    3,
    4
  ],
  "exa.cortex_pb.PermissionConfig": [
    1,
    2,
    5,
    6
  ],
  "exa.cortex_pb.EnterpriseToolConfig": [
    1,
    2
  ],
  "exa.codeium_common_pb.PermissionGrantsConfig": [
    1,
    2,
    3
  ],
  "exa.cortex_pb.PlannerRetryConfig": [
    2
  ],
  "exa.cortex_pb.ModelAPIRetryConfig": [
    1,
    2,
    3,
    4,
    5,
    6
  ],
  "exa.cortex_pb.CustomizationConfig": [
    1,
    2,
    3,
    4,
    6,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21
  ],
  "exa.cortex_pb.CustomizationDiscoveryConfig": [
    1,
    2,
    6,
    8,
    10
  ],
  "exa.cortex_pb.SkillsConfig": [
    2,
    3,
    4,
    5,
    6
  ],
  "exa.cortex_pb.CustomizationPath": [
    1,
    2,
    3
  ],
  "exa.cortex_pb.WorkspacePaths": [
    1
  ],
  "exa.cortex_pb.AgentDiscoveryConfig": [
    1,
    2
  ],
  "exa.cortex_pb.DeclarativeComponentConfig": [
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    10,
    11
  ],
  "exa.cortex_pb.PromptSectionItem": [
    2
  ],
  "exa.cortex_pb.NamedItem": [
    1,
    2,
    3,
    4
  ],
  "exa.cortex_pb.CascadeExecutorConfig": [
    1,
    2,
    3,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26
  ],
  "exa.cortex_pb.CustomAgentSpec": [
    3,
    5,
    6,
    8,
    10,
    13
  ],
  "exa.cortex_pb.BuiltinAgentConfig": [
    1,
    2
  ],
  "exa.cortex_pb.DefaultAgentConfig": [
    1,
    2,
    3,
    4,
    5
  ],
  "exa.codeium_common_pb.ModelUsageStats": [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13
  ],
  "exa.codeium_common_pb.ModelUsageStats.ResponseHeaderEntry": [
    1,
    2
  ],
  "exa.cortex_pb.CortexStepPlannerResponse": [
    1,
    3,
    4,
    5,
    6,
    7,
    8,
    11,
    12,
    14,
    15,
    16
  ],
  "exa.codeium_common_pb.ChatToolCall": [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9
  ],
  "google.protobuf.Duration": [
    1,
    2
  ],
  "exa.hooks_pb.PreToolHookResult": [
    1,
    2,
    4,
    5,
    6
  ],
  "exa.cortex_pb.CortexStepGeneric": [
    1,
    2
  ],
  "exa.cortex_pb.CortexStepGeneric.ArgsEntry": [
    1,
    2
  ],
  "exa.cortex_pb.GenericStepResult": [
    1,
    3,
    6,
    7
  ],
  "google.protobuf.Any": [
    1,
    2
  ],
  "exa.cortex_pb.StepRenderInfo": [
    1,
    2,
    4,
    5,
    6,
    7,
    9,
    11
  ],
  "exa.cortex_pb.StepRenderInfo.TitlePart": [
    1,
    2
  ],
  "exa.cortex_pb.StepRenderInfo.FileRef": [
    1,
    2,
    3
  ],
  "exa.cortex_pb.CortexErrorDetails": [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    9,
    10,
    11,
    12
  ]
}
```

## Database and terminal policy

SQLite is opened readonly/fileMustExist/query_only and read in one deferred
transaction; no CLI, RPC, model, or tools are invoked. `trajectory_meta.cascade_id`
must match the UUID filename/init/result/requested-resume binding. Resume uses
pre-spawn MAX(idx) plus an unchanged anchor and database inode; missing baseline
means no recovery. Fresh uses -1, an existing-file snapshot, and birthtime >=
prepare timestamp: coarse clock/file-creation ambiguity fails closed (never add
an age tolerance that admits pre-launch databases). The module does not create
the conversations directory; a fresh absent directory is allowed and resolved
through its nearest existing canonical ancestor.

After baseline: contiguous indices, exactly one first USER_INPUT, exact UTF-8
`message.content` hash, matching SQL/payload type/status, format 0. Generic tools
must match pending planner call IDs and end DONE (3) or terminal ERROR (7);
RUNNING/WAITING/CANCELED/etc are rejected. Official evidence has tool-bearing
planner responses with STOP_PATTERN (2), so intermediate tool calls accept 2 or
FUNCTION_CALL (10), but the final planner requires DONE/STOP_PATTERN/no tool calls.
`response` and `modified_response` must be equal or only one nonempty; thinking
and raw_thinking are never returned.

The adapter alone gates SUCCESS, actual close/exit 0, cancel/abandon/error state,
empty visible/terminal text, final recheck after awaiting recovery, appendText,
persistence acknowledgement and single settlement. This module provides no
billing, persistence or lifecycle-success assertion.
