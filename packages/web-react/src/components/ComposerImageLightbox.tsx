import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export default function ComposerImageLightbox({
  preview,
  onClose,
}: {
  preview: { url: string; name: string };
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 focus:outline-none"
        >
          <Dialog.Title className="sr-only">{preview.name || "图片预览"}</Dialog.Title>
          <img
            src={preview.url}
            alt={preview.name}
            className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-float"
          />
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="关闭预览"
              className="absolute -right-2 -top-2 flex size-8 items-center justify-center rounded-full bg-surface text-fg shadow-float outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
