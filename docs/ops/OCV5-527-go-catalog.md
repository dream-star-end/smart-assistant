## 2026-10-19 20:09 用户变更：x0.2 + 跨路线去重（取代上节方案）

当前29个active Go模型 → 保留14个、停用15个（旧版本9个+跨路线重复6个）。倍率下限x0.2；全部原为x1.000，故14个保留模型仍x1.000，价格变更0项。历史7条disabled/retired保持。

先选每条产品线最新版本，再剔除已在其它启用路线提供的同模型；不会因为最新版在别处提供而回填过时Go版本。Contributor是渠道标签，Argon不同effort/context不视为不同模型；Fast/思考档位也不另造模型。Flash/Pro/Max/Plus/Code等明确产品定位仍分系列。

| 模型ID | 变更前 | 变更后 | 原因 |
|---|---|---|---|
| claude-haiku-5-5-go | active / x1.000 | disabled（倍率保留） | 其它路线已提供同模型：box-claude-haiku-5-5 / box_cli |
| gemini-4-argon-contributor | active / x1.000 | disabled（倍率保留） | 其它路线已提供同模型：antigravity-gemini-4-argon / antigravity（Contributor是渠道标签） |
| glm-5.2-go | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| glm-5.3-flash-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| glm-5.3-go | active / x1.000 | disabled（倍率保留） | 其它路线已提供同模型：glm-5.3-zai / zai |
| hy3-go | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| hy4-preview-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| kimi-k2.6-go | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| kimi-k2.7-code-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| kimi-k3-go | active / x1.000 | disabled（倍率保留） | 其它路线已提供同模型：kimi-k3、k3-256k / moonshot |
| longcat-2.0-go | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| longcat-2.5-preview-free-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| mimo-v2.5-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| mimo-v2.5-pro-go | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| mimo-v2.6-flash-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| mimo-v2.6-pro-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| minimax-m2.7-go | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| minimax-m3-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| muse-spark-1.2-go | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| muse-spark-1.3-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| opencode-gpt-5.6-luna | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| opencode-gpt-6-luna | active / x1.000 | disabled（倍率保留） | 其它路线已提供同模型：gpt-6-luna、gpt-6-luna-1m / codex |
| opencode-grok-4.6 | active / x1.000 | disabled（倍率保留） | 同系列已有更新版本 |
| opencode-grok-4.7 | active / x1.000 | disabled（倍率保留） | 其它路线已提供同模型：grok-build / grok；另有cursor同版本各档位 |
| qwen3.7-plus-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| qwen3.8-flash-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| qwen3.8-max-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| space-bunny-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |
| step-5-preview-free-go | active / x1.000 | active / x1.000 | 当前系列最新，且其它启用路线无同模型 |

发现实际依赖：selfhost发布G1门固定要求opencode-gpt-6-luna在canary目录中。直接停用它会导致后续每次发布必失败。因此本票PR把真实Go缓存契约改为固定保留模型Muse Spark 1.3，并保持3轮、缓存命中率>=0.5、原超时、真实WS、逐sessionusage检查及不允许模型覆盖的规则。原Luna零命中形态回归仍保留；源代码特定Responses回归不删。先在现有目录实测Muse缓存，证明替代适用，再发布此门变更，最后停用重复目录。不能先停Luna，也不跳过G1。
如果Muse无法满足缓存契约，停在已推分支并报告，不降低门槛、不用旧Go模型凑数。商用门脚本不变，商业目录不变。

补充独立分析：Muse1.3与Go Luna同走Responses桥。历史修复前Muse真实3轮ratio约0.319，原0.3会错误放行；修复后约0.664。因此将固定阈值提高到0.5，并将真实旧/新用量形态写入回归。一次缓存逐出约0.333将按新严格门失败，更新过期断言，不放宽请求数或超时。

本文件为操作规划；实际目录状态、审计号、验证收据以本票CONTINUE和g527证据目录为准。源码提交不执行目录变更。
