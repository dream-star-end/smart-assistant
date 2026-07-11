/**
 * 图片编辑动作 context（需求 B/§5 的「进主对话」+「移除」下传通道）。
 *
 * 注入哲学同 ToolCardActions / ChatInteraction：**有 provider 才可用，无则降级**。
 * 由 App（provider 侧，Agent-P 所有）注入 `submitImageEdit` + `onRemoveImage`；由
 * ImageViewer / 全屏编辑器（consumer 侧，Agent-V 所有）消费：编辑/评论/调整大小三态
 * 提交都走 `submitImageEdit`（App 统一 handler 泛化 → send() → 乐观 user 行 + 生成占位卡），
 * 「移除」走 `onRemoveImage`（client 侧隐藏该图，本地持久化、不上服务端）。
 *
 * `ImageEditSubmit` 契约的单一权威在本文件（image-ux 实施计划 §4 定死）；Agent-V 的
 * ImageViewer 从这里 re-export 给 comment/resize 模式复用。
 */
import { createContext, useContext } from "react";
import type { InboundMessage } from "../../lib/chat/frames";

/** 调整大小目标比例（五枚举）——直接从 protocol imageEdit.targetAspect 派生，单一权威。 */
export type ImageEditTargetAspect = NonNullable<
  NonNullable<InboundMessage["content"]["imageEdit"]>["targetAspect"]
>;

/**
 * 三态图片编辑提交（App.submitImageEdit 的入参联合，实施计划 §4）。
 *  - 编辑/评论（annotated）：源图 + mask + guide 三件套 → 走既有 annotated-edit 帧链路。
 *    `mode` 省略或 'edit'/'comment' 都按 annotated 处理（现有 ImageAnnotationExport 无 mode，
 *    天然落此分支，向后兼容）。
 *  - 调整大小（resize / outpaint）：源图 + guide（无 mask）+ 目标比例 targetAspect。
 */
export type ImageEditSubmit =
  | {
      mode?: "edit" | "comment";
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

export type ImageEditActions = {
  /** 编辑/评论/调整大小提交 → 进主对话生成（乐观 user 行 + 生成占位卡）。 */
  submitImageEdit?: (value: ImageEditSubmit) => void | Promise<void>;
  /** 移除生成图（client 侧隐藏，需确认由调用方 UI 负责）。 */
  onRemoveImage?: (signPath: string) => void;
  /** 该图是否已被本地移除（隐藏渲染的单一判定；set 变化时 provider value 换新触发重渲）。 */
  isMediaHidden?: (signPath: string) => boolean;
};

export const ImageEditActionsContext = createContext<ImageEditActions>({});

export function useImageEditActions(): ImageEditActions {
  return useContext(ImageEditActionsContext);
}
