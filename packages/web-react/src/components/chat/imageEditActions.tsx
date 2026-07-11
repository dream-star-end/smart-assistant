/**
 * 图片编辑动作 context —— **图片编辑入口的单一权威**。
 *
 * 注入哲学同 ToolCardActions / ChatInteraction：**有 provider 才可用，无则降级**。
 * 由 App（provider 侧）注入；consumer 侧统一从这里取：
 *   - `submitImageEdit`：编辑/调整大小两态提交 → App 统一 handler 泛化 → send() →
 *     乐观 user 行 + 生成占位卡。**其存在与否 = 「当前是否可编辑图片」的唯一判定**
 *     (image2 开放 + 当前模型是 GPT 引擎时才注入)，聊天缩略图「编辑」浮钮、全屏查看器
 *     底部编辑/调整大小动作都据此显隐/禁用,不再各自平行判定。
 *   - `submitImageComment`：评论模式提交 → **普通模型 turn**(media=原图 + 百分比坐标文本),
 *     由 GPT 看图+坐标调它自己的原生 imagegen 精确修改。与 submitImageEdit 同门控(image2/
 *     GPT 引擎),不再客户端合成 mask/guide,故不走 annotated 帧。
 *   - `annotate`：为一张**本地/对话框附件图**打开精确圈选编辑器(composer 用)。与
 *     submitImageEdit 同源(同一 image2 门控),消除此前 composer `onAnnotateImage` prop
 *     与聊天图 MediaSignProvider.onAnnotate 两套平行机制。
 *   - `annotateUnavailableReason`：不可编辑时给禁用 UI 的人类可读原因(模型门控文案)。
 *
 * `ImageEditSubmit` 契约的单一权威在本文件（image-ux 实施计划 §4 定死）；ImageViewer
 * 从这里 re-export 给 comment/resize 模式复用。
 */
import { createContext, useContext } from "react";
import type { InboundMessage } from "../../lib/chat/frames";

/** 调整大小目标比例（五枚举）——直接从 protocol imageEdit.targetAspect 派生，单一权威。 */
export type ImageEditTargetAspect = NonNullable<
  NonNullable<InboundMessage["content"]["imageEdit"]>["targetAspect"]
>;

/**
 * 图片编辑提交（App.submitImageEdit 的入参联合，实施计划 §4）。
 *  - 编辑（annotated）：源图 + mask + guide 三件套 → 走既有 annotated-edit 帧链路。
 *    `mode` 省略或 'edit' 都按 annotated 处理（现有 ImageAnnotationExport 无 mode，
 *    天然落此分支，向后兼容）。
 *  - 调整大小（resize / outpaint）：源图 + guide（无 mask）+ 目标比例 targetAspect。
 *  评论模式已改「普通模型 turn」(原图 media + 百分比坐标文本)走 submitImageComment，
 *  不再客户端合成 annotated 三件套,故此联合**不含**评论态。
 */
export type ImageEditSubmit =
  | {
      mode?: "edit";
      clientJobId: string;
      prompt: string;
      source: File;
      mask: File;
      guide: File;
      width: number;
      height: number;
    }
  | {
      mode: "resize";
      clientJobId: string;
      prompt: string;
      source: File;
      guide: File;
      width: number;
      height: number;
      /** 目标比例枚举（"16:9" | "4:3" | "9:16" | "3:4" | "1:1"，protocol 派生）。 */
      targetAspect: ImageEditTargetAspect;
    };

/**
 * 评论模式提交（App.submitImageComment 的入参，ChatGPT 同款「模型驱动精确修改」）。
 * 评论 = 一条**普通对话消息**:media=[原图(可见)] + text=固定前导 + 每锚点百分比坐标行。
 * 由 GPT 看图+坐标调它自己的原生 imagegen 完成精确修改,不再合成 mask/guide 走 imageEdit 帧。
 */
export type ImageCommentSubmit = {
  /** 已构建好的对话文本(前导+坐标行)。 */
  text: string;
  /** 可直接复用的持久图片引用(/api/media);为空则用 sourceFile 上传一次。 */
  reuseUrl?: string;
  /** reuseUrl 为空时携带的原图字节(App 侧 uploadMedia → /api/media)。 */
  sourceFile?: File;
};

export type ImageEditActions = {
  /**
   * 编辑/调整大小提交 → 进主对话生成（乐观 user 行 + 生成占位卡）。
   * 存在与否即「当前可否编辑图片」的单一判定（image2 门控），消费方据此显隐/禁用编辑入口。
   */
  submitImageEdit?: (value: ImageEditSubmit) => void | Promise<void>;
  /**
   * 评论模式提交 → **普通模型 turn**(media 原图 + 百分比坐标文本),而非 annotated 三件套。
   * 与 submitImageEdit 同门控(image2 开放 + GPT 引擎);存在与否 = 评论动作可否用。
   */
  submitImageComment?: (value: ImageCommentSubmit) => void | Promise<void>;
  /** 为一张本地/对话框附件图打开精确圈选编辑器（composer 用；与 submitImageEdit 同门控）。 */
  annotate?: (source: { url: string; name?: string }) => void;
  /** 不可编辑时的人类可读原因（模型门控文案），供禁用入口的 title/tooltip 使用。 */
  annotateUnavailableReason?: string;
};

export const ImageEditActionsContext = createContext<ImageEditActions>({});

export function useImageEditActions(): ImageEditActions {
  return useContext(ImageEditActionsContext);
}
