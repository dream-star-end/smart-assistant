# 第三方许可声明（OCV5-402）

本目录的 B 站连接器（`bili.ts`）、`../builtins/runtime.ts` 中的 B 站部分，以及受管浏览器插件 `bili-account`
（`packages/commercial/src/plugins/bili*.ts`），改写自下列 MIT 许可的开源项目。按 MIT 许可要求，原版权声明与许可全文保留如下。

- 项目：dream-star-end/agent-plugins，目录 `bili/`
- 地址：https://github.com/dream-star-end/agent-plugins
- 取用版本：commit 1ea1f550125c925fcab5c89f53dfd5a9ee6b7031（2026-10-12）
- 取用内容：B 站 Web 接口清单与参数、WBI 签名的 mixin 表与步骤、buvid 指纹获取方式、评论排序模式、弹幕 raw deflate 处理、字段整形思路。未取用写操作与本机凭据文件；未取用 `qrcodegen.py`（平台扫码直接截取 B 站官方登录页的二维码）。

```text
MIT License

Copyright (c) 2026 ths-plugin contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
