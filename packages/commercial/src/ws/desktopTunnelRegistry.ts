/**
 * In-process desktop reverse-tunnel registry skeleton (P1 B-stage).
 * Mux / openWs / http land in C-stage. Mint/revoke/expiry call drop().
 */

export interface DesktopTunnelMeta {
  deviceId: string;
  uid: number;
  expiresAt: Date;
}

export interface DesktopTunnelHandle {
  close?: (code?: number, reason?: string) => void;
}

export interface DesktopTunnelSlot extends DesktopTunnelMeta {
  containerId: number;
  attachedAt: Date;
}

export interface DesktopTunnelRegistry {
  attach(containerId: number, handle: DesktopTunnelHandle | null, meta: DesktopTunnelMeta): void;
  get(containerId: number): DesktopTunnelSlot | undefined;
  drop(containerId: number, reason?: string): boolean;
  size(): number;
}

class MemoryDesktopTunnelRegistry implements DesktopTunnelRegistry {
  private readonly slots = new Map<number, DesktopTunnelSlot & { handle: DesktopTunnelHandle | null; timer: ReturnType<typeof setTimeout> | null }>();

  attach(containerId: number, handle: DesktopTunnelHandle | null, meta: DesktopTunnelMeta): void {
    this.drop(containerId, "replaced");
    const ms = Math.max(0, meta.expiresAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.drop(containerId, "expired");
    }, ms);
    timer.unref?.();
    this.slots.set(containerId, {
      containerId,
      deviceId: meta.deviceId,
      uid: meta.uid,
      expiresAt: meta.expiresAt,
      attachedAt: new Date(),
      handle,
      timer,
    });
  }

  get(containerId: number): DesktopTunnelSlot | undefined {
    const s = this.slots.get(containerId);
    if (!s) return undefined;
    const { handle: _h, timer: _t, ...slot } = s;
    return slot;
  }

  drop(containerId: number, _reason?: string): boolean {
    const s = this.slots.get(containerId);
    if (!s) return false;
    this.slots.delete(containerId);
    if (s.timer) clearTimeout(s.timer);
    try {
      s.handle?.close?.(4001, "desktop_tunnel_dropped");
    } catch { /* ignore */ }
    return true;
  }

  size(): number {
    return this.slots.size;
  }
}

let singleton: MemoryDesktopTunnelRegistry | null = null;

export function getDesktopTunnelRegistry(): DesktopTunnelRegistry {
  singleton ??= new MemoryDesktopTunnelRegistry();
  return singleton;
}

export function resetDesktopTunnelRegistryForTest(): MemoryDesktopTunnelRegistry {
  singleton?.drop(Number.NaN);
  singleton = new MemoryDesktopTunnelRegistry();
  return singleton;
}

export function createMemoryDesktopTunnelRegistry(): DesktopTunnelRegistry {
  return new MemoryDesktopTunnelRegistry();
}
