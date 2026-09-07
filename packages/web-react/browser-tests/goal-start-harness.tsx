import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
createRoot(document.getElementById("root")!).render(
  <ToastProvider><TooltipProvider><App /></TooltipProvider></ToastProvider>
);
