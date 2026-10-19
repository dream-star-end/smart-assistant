## 2026-10-19 20:26 用户确认后的最终执行方案

以界面cost_x为准，内部multiplier全部保持1.000。Go29启用→14保留/15停用，保留中8项x0.1、3项x0.0调整到x0.2；Hy4原x0.2、KimiCode原x0.4、QwenMax原x0.7保持。

cost_x基线仍为deepseek-v4-pro原单价225/675/7/0，未修改。对已有非零价模型按相同系数抬高四轴单价，取整数分向上取整，使实际混合成本不低于基线0.2倍且界面四舍五入为x0.2。原四轴全零的LongCat/Step使用基线0.2倍向上取整：45/135/2/0。Muse原非零价但界面舍入x0.0，本次提高到显示x0.2。收费后的LongCat/Step显示名移除Free，保留模型ID及上游-free名称以兼容历史。

价格单位为积分/百万token（输入/输出/缓存读/缓存写）；内部倍率不变。

| 保留模型 | UI前→后 | 单价前 | 单价后 | 内部倍率 |
|---|---|---|---|---|
| glm-5.3-flash-go | x0.1 → x0.2 | 7/25/1/0 | 26/93/4/0 | 1.000 |
| hy4-preview-go | x0.2 → x0.2 | 41/125/2/0 | 41/125/2/0 | 1.000 |
| kimi-k2.7-code-go | x0.4 → x0.4 | 47/200/9/0 | 47/200/9/0 | 1.000 |
| longcat-2.5-preview-free-go | x0.0 → x0.2 | 0/0/0/0 | 45/135/2/0 | 1.000 |
| mimo-v2.5-go | x0.1 → x0.2 | 7/14/1/0 | 27/53/4/0 | 1.000 |
| mimo-v2.6-flash-go | x0.1 → x0.2 | 7/14/1/0 | 27/53/4/0 | 1.000 |
| mimo-v2.6-pro-go | x0.1 → x0.2 | 21/43/1/0 | 42/85/2/0 | 1.000 |
| minimax-m3-go | x0.1 → x0.2 | 15/60/3/0 | 22/85/5/0 | 1.000 |
| muse-spark-1.3-go | x0.0 → x0.2 | 5/10/1/0 | 22/44/5/0 | 1.000 |
| qwen3.7-plus-go | x0.1 → x0.2 | 20/80/2/25 | 31/123/4/39 | 1.000 |
| qwen3.8-flash-go | x0.1 → x0.2 | 7/23/1/10 | 26/86/4/38 | 1.000 |
| qwen3.8-max-go | x0.7 → x0.7 | 100/300/12/125 | 100/300/12/125 | 1.000 |
| space-bunny-go | x0.1 → x0.2 | 7/30/1/0 | 26/110/4/0 | 1.000 |
| step-5-preview-free-go | x0.0 → x0.2 | 0/0/0/0 | 45/135/2/0 | 1.000 |

停用15项：claude-haiku-5-5-go, gemini-4-argon-contributor, glm-5.2-go, glm-5.3-go, hy3-go, kimi-k2.6-go, kimi-k3-go, longcat-2.0-go, mimo-v2.5-pro-go, minimax-m2.7-go, muse-spark-1.2-go, opencode-gpt-5.6-luna, opencode-gpt-6-luna, opencode-grok-4.6, opencode-grok-4.7。

用live的patchPricing一次提交每项四轴单价与if_match_lock_version；共11项价格patch。同原disableEntry流程停15项；每项均有审计。其它路线价格/目录、基线不变，不删历史。
Muse收费不影响缓存token比率计算：G1仍要求3轮、缓存读比例>=0.5及真实Responses桥。预验如在调价前发生，保留其当时冻结价格；发布后调价后的Muse调用按新单价核账，不把旧价格收据冒充新价格验证。

本PR仅迁移缓存契约；目录与价格将通过live admin API执行，证据见OCV5-527交接文件。PR生效前不停Go Luna。
