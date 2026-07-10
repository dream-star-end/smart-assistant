// 类型声明:随 qrcodeGenerator.js(上游 qrcode-generator@1.4.4,MIT)一同 vendored。
// 仅声明本页 iLink 绑定二维码用到的最小面。
export interface QrCodeModel {
  addData(data: string, mode?: string): void;
  make(): void;
  getModuleCount(): number;
  /** 生成 GIF data:URL(纯 JS,无 canvas 依赖,jsdom/node 亦可运行)。 */
  createDataURL(cellSize?: number, margin?: number): string;
}

/**
 * @param typeNumber 0 = 自动按数据量选型号。
 * @param errorCorrectionLevel 'L' | 'M' | 'Q' | 'H'。
 */
declare function qrcode(typeNumber: number, errorCorrectionLevel: string): QrCodeModel;
export default qrcode;
