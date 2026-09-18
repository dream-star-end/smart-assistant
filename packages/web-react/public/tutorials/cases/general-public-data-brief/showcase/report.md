# 三份公开数据，一页三国比较简报

> 公开数据样例实作。成果生成：2026-09-07T04:13:30Z（UTC）；观测年份：2022；入库响应元数据 lastupdated：2026-07-13。三者不是同一概念。本报告独立于旧 fieldReport，不认证旧耗时或测试结果。

## 原始任务与交付

将印度尼西亚、菲律宾、越南的人口、人均GDP、互联网使用率整理为可比较、可追溯、可切换的看板，写出不超越证据边界的简报。

实际读取3份已入库World Bank JSON，共9条观测，按ISO3与年份连接为3行。没有网络访问，没有重新获取源站最新值。

## 同年对齐结果

| 国家 | 年份 | 人口（人） | 人均GDP（当年美元/人） | 联网率（%） | 估算联网人数（人） |
| --- | --- | ---: | ---: | ---: | ---: |
| 印度尼西亚 | 2022 | 278,830,529 | 4,730.83 | 66.4846 | 185,379,397 |
| 菲律宾 | 2022 | 113,964,338 | 3,548.07 | 75.2111 | 85,713,883 |
| 越南 | 2022 | 99,680,655 | 4,147.70 | 78.5900 | 78,339,026 |

原始精度保留在CSV/JSON。估算联网人数是人口×联网率/100的派生近似量，不是另一个官方原始指标。

## 三点观察

1. 规模不等于覆盖率。印度尼西亚样本人口最大，越南联网率最高；按问题选择指标，不把不同量纲强行合成得分。
2. 估算有用，但不能夸大。三个样本合计人口 492,475,522 人，估算联网人数约 349,432,306 人；这不是产品用户、可触达客户、付费意愿或市场收入。
3. 人均GDP不等于个人收入。这里是当年美元口径，不是购买力平价，不能直接等同居民消费预算，不能据此决定进入哪个国家。

## 数据源与单位

- 人口：SP.POP.TOTL；单位 人；[World Bank API](https://api.worldbank.org/v2/country/IDN;PHL;VNM/indicator/SP.POP.TOTL?date=2022&format=json&per_page=100)；元数据 lastupdated=2026-07-13。
- 人均 GDP：NY.GDP.PCAP.CD；单位 当年美元 / 人；[World Bank API](https://api.worldbank.org/v2/country/IDN;PHL;VNM/indicator/NY.GDP.PCAP.CD?date=2022&format=json&per_page=100)；元数据 lastupdated=2026-07-13。
- 互联网使用率：IT.NET.USER.ZS；单位 %；[World Bank API](https://api.worldbank.org/v2/country/IDN;PHL;VNM/indicator/IT.NET.USER.ZS?date=2022&format=json&per_page=100)；元数据 lastupdated=2026-07-13。

## 处理、缺失与实际检查

- 验证JSON页数、总记录数、指标ID、ISO3和观测年份。
- 按(countryiso3code,year)连接，不依赖行顺序；重复键报错。
- 非空值为有限数；人口/GDP非负、联网率在0–100范围。
- 本次缺失 0 个指标单元格；解析层保留null，CSV为空，不插补。若未来输入出现缺失，发布脚本会要求更新完整样本文案后再生成，不沿用当前完整样本结论。
- 估算联网人数=population*internet/100。人口加权联网率仅使用两项同时有效的国家，不是各国百分比简单平均。
- 本次只有2022年横截面，不声称时间趋势。看板按当前指标降序或ISO3顺序排列。
- manifest记录3个输入与4个产物SHA-256及字节数，不哈希manifest自身。

只读复算命令：

    python3 packages/web-react/scripts/build-showcase-evidence.py --check

重新读取源JSON，重算派生值和所有产物，核对完整字节与哈希。这不是平台端到端回放，也不核验旧案例耗时或测试数。

## 附件与边界

[比较看板](dashboard.html) · [对齐CSV](derived.csv) · [精确JSON](metrics.json) · [来源与校验](manifest.json)

如用于真实决策，还需行业需求、法规、支付/物流、竞争、获客成本等证据。不是全东南亚排名，不构成投资、市场进入或收益承诺，没有未经验证的“综合机会评分”。
