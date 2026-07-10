import qrcode from "./qrcodeGenerator.js";

/**
 * 把任意字符串编码成二维码 data:URL(GIF)。
 *
 * iLink 的 `/alerts/ilink/qrcode` 返回的 `qrcode_img_content` 是"扫码后跳转的
 * liteapp.weixin.qq.com 短链"字符串,不是图片 —— 必须客户端把它 encode 成二维码图。
 * 与旧 vanilla admin 的 `_qrDataUrl`(同一 qrcode-generator 库)口径一致:type=0 自动选型,
 * 纠错级 M,margin=2,cellSize 按目标像素宽自适应。
 */
export function qrDataUrl(text: string, size = 240): string {
  const qr = qrcode(0, "M");
  qr.addData(String(text));
  qr.make();
  const modules = qr.getModuleCount();
  const cellSize = Math.max(1, Math.floor(size / (modules + 4)));
  return qr.createDataURL(cellSize, 2);
}
