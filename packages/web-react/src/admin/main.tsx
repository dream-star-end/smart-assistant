import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider, TooltipProvider } from "../components/ui";
import "../styles.css";
import { AdminApp } from "./AdminApp";
import { installGlobalClientFrictionHandlers } from "../lib/clientFriction";

// 管理后台第二入口（/admin.html）。与用户端共享设计系统 token / UI 原语 / chart.js。
// 注意：**不注册 Service Worker**（admin 是运维工具、无离线/安装诉求；且 sw.js 已把
// /admin.html 从共享离线壳中摘出，见 public/sw.js）。
installGlobalClientFrictionHandlers();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <TooltipProvider>
        <AdminApp />
      </TooltipProvider>
    </ToastProvider>
  </StrictMode>,
);
