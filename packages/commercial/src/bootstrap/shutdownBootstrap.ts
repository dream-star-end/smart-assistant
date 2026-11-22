/**
 * Graceful shutdown ordering and dependency health probing for @openclaude/commercial.
 *
 * Extracted from packages/commercial/src/index.ts (OCV5-830).
 */
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type IORedis from "ioredis";
import { shutdownDurableMetricRollups } from "../admin/durableMetricRollups.js";
import { markGatewayShutdownEvidence } from "../billing/finalizeJournalReconciler.js";
import { getImagePromoteScheduler } from "../compute-pool/imagePromote.js";
import { closePool, getPool } from "../db/index.js";
import { closeModelCatalogAdminPool } from "../db/modelCatalogAdmin.js";

export interface CommercialShutdownHandles {
  stopLogTiming: () => void;
  closeSystemActionsAdmission?: () => void;
  sessionsGcSweeper?: { stop: () => Promise<void> } | null;
  wechatBroker?: { stop: () => Promise<void> };
  getContainerPreviewBridge: () => { shutdown: () => Promise<void> } | undefined;
  clearContainerPreviewBridge: () => void;
  getDirectContainerPreview: () => { shutdown: () => Promise<void> } | undefined;
  clearDirectContainerPreview: () => void;
  getChatgptProxyServer: () => { close: () => Promise<void> } | undefined;
  clearChatgptProxyServer: () => void;
  closeMusePublic?: () => Promise<void>;
  stopStudioOrchestrator?: () => Promise<void>;
  museHub?: { stop: () => Promise<void> };
  voiceTranscribeHandler: { shutdown: () => Promise<void> };
  userChatBridge: { shutdown: () => Promise<void> };
  cursorExternalRoute?: { close: () => Promise<void> };
  drainManagedWorkers: () => Array<Promise<unknown> | undefined>;
  leaderLease?: { shutdown: () => Promise<void> };
  leaderBundle: { stopAndDrain: () => Promise<unknown> };
  getTurnDispatchShutdownHandoff: () => (() => Promise<unknown>) | undefined;
  controlListener?: { close: () => Promise<void> };
  deployDesiredWatch?: { stop: () => void };
  lifecycleScheduler?: { stop: () => Promise<void> };
  codexRefreshActor?: { stop: () => void };
  subscriptionRolloverSweeper?: { stop: () => void };
  accountSlotReaper?: { stop: () => void };
  logLevelSync: { stop: () => void };
  codexDriftReconciler?: { stop: () => void };
  researchJobScheduler?: { stop: () => void };
  marketplaceAiReviewScheduler?: { stop: () => void };
  providerHealthScheduler?: { stop: () => void };
  baselineSrv?: { stop: () => Promise<void> };
  internalProxyServer?: HttpServer;
  externalMtlsServer?: HttpsServer;
  getDesktopTlsClose: () => (() => Promise<void>) | undefined;
  disposePendingDecisions?: () => void;
  clearGatewayProviders: () => void;
  pricing: { shutdown: () => Promise<void> };
  redis: IORedis;
}

async function closeNodeServer(server: HttpServer | HttpsServer): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
      const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
      if (typeof closeAll === "function") closeAll.call(server);
    } catch {
      resolve();
    }
  });
}

export function createCommercialShutdown(handles: CommercialShutdownHandles): () => Promise<void> {
  return async () => {
    handles.closeSystemActionsAdmission?.();
    handles.stopLogTiming();
    if (handles.sessionsGcSweeper) {
      try {
        await handles.sessionsGcSweeper.stop();
      } catch {
        /* ignore */
      }
    }
    if (handles.wechatBroker) {
      try {
        await handles.wechatBroker.stop();
      } catch {
        /* ignore */
      }
    }
    const previewBridge = handles.getContainerPreviewBridge();
    handles.clearContainerPreviewBridge();
    const directPreview = handles.getDirectContainerPreview();
    handles.clearDirectContainerPreview();
    const cgpServer = handles.getChatgptProxyServer();
    handles.clearChatgptProxyServer();
    try { await cgpServer?.close(); } catch { /* ignore */ }
    try { await handles.closeMusePublic?.(); } catch { /* ignore */ }
    try { await handles.stopStudioOrchestrator?.(); } catch { /* ignore */ }
    try { await handles.museHub?.stop(); } catch { /* ignore */ }
    try { await directPreview?.shutdown(); } catch { /* ignore */ }
    try { await previewBridge?.shutdown(); } catch { /* ignore */ }
    try { await handles.voiceTranscribeHandler.shutdown(); } catch { /* ignore */ }
    try { await handles.userChatBridge.shutdown(); } catch { /* ignore */ }
    try { await handles.cursorExternalRoute?.close(); } catch { /* ignore */ }
    try {
      await Promise.allSettled(handles.drainManagedWorkers());
    } catch {
      /* ignore */
    }
    if (handles.leaderLease) {
      try { await handles.leaderLease.shutdown(); } catch { /* ignore */ }
    } else {
      try { await handles.leaderBundle.stopAndDrain(); } catch { /* ignore */ }
    }
    try {
      const handoff = handles.getTurnDispatchShutdownHandoff();
      if (handoff) {
        await handoff();
      } else {
        await markGatewayShutdownEvidence({ reason: "process_shutdown" });
      }
    } catch {
      /* ignore — exit takes precedence; conservative thresholds cover missing evidence */
    }
    if (handles.controlListener) {
      try { await handles.controlListener.close(); } catch { /* ignore */ }
    }
    if (handles.deployDesiredWatch) {
      try { handles.deployDesiredWatch.stop(); } catch { /* ignore */ }
    }
    if (handles.lifecycleScheduler) {
      try { await handles.lifecycleScheduler.stop(); } catch { /* ignore */ }
    }
    try { getImagePromoteScheduler().stop(); } catch { /* ignore */ }
    if (handles.codexRefreshActor) {
      try { handles.codexRefreshActor.stop(); } catch { /* ignore */ }
    }
    if (handles.subscriptionRolloverSweeper) {
      try { handles.subscriptionRolloverSweeper.stop(); } catch { /* ignore */ }
    }
    if (handles.accountSlotReaper) {
      try { handles.accountSlotReaper.stop(); } catch { /* ignore */ }
    }
    try { handles.logLevelSync.stop(); } catch { /* ignore */ }
    if (handles.codexDriftReconciler) {
      try { handles.codexDriftReconciler.stop(); } catch { /* ignore */ }
    }
    if (handles.researchJobScheduler) {
      try { handles.researchJobScheduler.stop(); } catch { /* ignore */ }
    }
    if (handles.marketplaceAiReviewScheduler) {
      try { handles.marketplaceAiReviewScheduler.stop(); } catch { /* ignore */ }
    }
    if (handles.providerHealthScheduler) {
      try { handles.providerHealthScheduler.stop(); } catch { /* ignore */ }
    }
    if (handles.baselineSrv) {
      try { await handles.baselineSrv.stop(); } catch { /* ignore */ }
    }
    if (handles.internalProxyServer) {
      await closeNodeServer(handles.internalProxyServer);
    }
    if (handles.externalMtlsServer) {
      await closeNodeServer(handles.externalMtlsServer);
    }
    const desktopTlsClose = handles.getDesktopTlsClose();
    if (desktopTlsClose) {
      await desktopTlsClose().catch(() => {});
    }
    try { handles.disposePendingDecisions?.(); } catch { /* ignore */ }
    handles.clearGatewayProviders();
    try { await handles.pricing.shutdown(); } catch { /* ignore */ }
    try { await handles.redis.quit(); } catch { /* ignore */ }
    await closeModelCatalogAdminPool();
    try { await shutdownDurableMetricRollups(); } catch { /* best-effort */ }
    await closePool();
  };
}

export function createCommercialProbeDeps(
  redis: IORedis,
): () => Promise<Record<string, { ok: true } | { ok: false; error: string }>> {
  return async () => {
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`probe timeout ${ms}ms`)), ms);
        timer.unref?.();
      });
      return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
    };
    const out: Record<string, { ok: true } | { ok: false; error: string }> = {};
    try {
      await withTimeout(getPool().query("SELECT 1"), 2000);
      out.pg = { ok: true };
    } catch (err) {
      out.pg = { ok: false, error: (err as Error).message };
    }
    try {
      await withTimeout(redis.ping(), 2000);
      out.redis = { ok: true };
    } catch (err) {
      out.redis = { ok: false, error: (err as Error).message };
    }
    return out;
  };
}
