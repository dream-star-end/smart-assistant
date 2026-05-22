---
name: browser-automation
description: "使用 Playwright MCP 浏览器工具的操作指南: 核心流程、表单填写、数据提取、反检测"
version: "1.0.0"
tags: [system, browser, automation]
related_skills: [platform-capabilities]
---

# 浏览器自动化操作指南

## 核心流程 (Snapshot-Driven)

浏览器操作基于 accessibility tree snapshot,不是截图。稳定且省 token。

```
1. browser_navigate(url="https://example.com")     → 打开网页
2. browser_snapshot()                                → 获取页面结构 + ref 编号
3. browser_click(ref="15")                           → 点击元素
4. browser_type(ref="23", text="搜索内容")           → 输入文字
5. browser_snapshot()                                → 刷新页面状态
6. 重复 2-5 直到任务完成
```

## 常用工具速查

| 工具 | 用途 | 示例 |
|------|------|------|
| `browser_navigate` | 打开 URL | `url="https://baidu.com"` |
| `browser_snapshot` | 获取页面结构(优先用这个) | 返回带 ref 的元素树 |
| `browser_click` | 点击元素 | `ref="12"` |
| `browser_type` | 输入文字 | `ref="7", text="关键词"` |
| `browser_fill_form` | 批量填表 | 多个 ref+value |
| `browser_press_key` | 按键 | `key="Enter"` |
| `browser_select_option` | 下拉选择 | `ref="9", value="option1"` |
| `browser_hover` | 悬停(触发菜单等) | `ref="5"` |
| `browser_wait_for` | 等待元素出现 | `selector=".result"` |
| `browser_take_screenshot` | 截图(需要视觉确认时) | 返回图片 |
| `browser_evaluate` | 执行 JS | `expression="document.title"` |
| `browser_tabs` | 列出标签页 | — |
| `browser_navigate_back` | 后退 | — |
| `browser_pdf_save` | 保存为 PDF | — |

## 操作模式

### 搜索信息
```
1. navigate 到搜索引擎
2. snapshot 找到搜索框 ref
3. type 输入关键词 + press_key Enter
4. snapshot 获取结果
5. click 进入详情页
6. snapshot 提取内容
```

### 填写表单
```
1. navigate 到表单页
2. snapshot 获取所有表单字段 ref
3. fill_form 批量填写
4. click 提交按钮
5. snapshot 确认结果
```

### 登录网站
```
1. navigate 到登录页
2. snapshot 找到用户名/密码输入框
3. type 填写凭据
4. click 登录按钮
5. wait_for 等待跳转
6. snapshot 确认登录成功
```

## 注意事项

- **优先 snapshot**: 比 screenshot 省 token 几十倍,且返回精确 ref
- **等待加载**: 动态页面用 `browser_wait_for` 等元素出现后再 snapshot
- **一步一验**: 每次操作后重新 snapshot 确认状态
- **错误恢复**: 点击失败时尝试 hover → 再 click,或用 evaluate 执行 JS
- **多标签页**: 用 browser_tabs 管理多个页面
- **反检测已启用**: stealth 脚本自动注入,通常不需要额外处理
