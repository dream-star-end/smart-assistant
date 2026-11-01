// Real Composer. Upload and send are counted locally. No backend and no user files.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

function Harness() {
  const [uploads, setUploads] = useState(0);
  const [sent, setSent] = useState("");
  return (
    <TooltipProvider>
      <ToastProvider>
        <output data-testid="uploads">{uploads}</output>
        <output data-testid="sent">{sent}</output>
        <Composer
          draftKey="upload-total"
          onSend={(text, media) => {
            setSent(`${text}|${media?.length ?? 0}`);
          }}
          onUpload={async () => {
            setUploads((count) => count + 1);
            return { kind: "file", url: "/api/media/fixture" };
          }}
        />
      </ToastProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
