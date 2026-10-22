import { Spinner } from "./ui";

/** 对话框懒块加载态——铺一层与 Dialog.Overlay 同款的半透明遮罩 + 居中 spinner,
 *  首次打开拉块的短暂空窗内给出「正在打开」的视觉,避免点击后无反馈。
 *  role=status + aria-live 让读屏用户也收到「正在加载」而非静默黑屏。*/
export function DialogFallback() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> 语义是"表单计算结果",这里是全屏加载遮罩,保留 div+role=status
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <Spinner size={22} />
      <span className="sr-only">加载中</span>
    </div>
  );
}
