import { BusinessError } from '@kit.BasicServicesKit';
import { connection } from '@kit.NetworkKit';
import { NetworkStateClock } from '../common/NetworkStateClock';

export type NetworkStateListener = (online: boolean) => void;

/**
 * Projects device connectivity into the native shell only. ArkWeb and the v5
 * WebSocket remain responsible for their own reconnect and retry semantics.
 */
export class NetworkMonitor {
  private readonly listener: NetworkStateListener;
  private netConnection: connection.NetConnection | undefined = undefined;
  private active: boolean = false;
  private registered: boolean = false;
  private readonly stateClock: NetworkStateClock = new NetworkStateClock();

  constructor(listener: NetworkStateListener) {
    this.listener = listener;
  }

  start(): void {
    if (this.netConnection !== undefined) {
      return;
    }

    const netConnection: connection.NetConnection = connection.createNetConnection();
    this.active = true;
    this.netConnection = netConnection;
    this.stateClock.advance();
    const initialQueryRevision: number = this.stateClock.capture();
    connection.hasDefaultNet()
      .then((online: boolean) => {
        if (this.canApplyQuery(netConnection, initialQueryRevision)) {
          this.listener(online);
        }
      })
      .catch(() => {
        // Keep the optimistic default when the system service is unavailable.
      });
    netConnection.on('netAvailable', () => {
      if (this.active && this.netConnection === netConnection) {
        this.stateClock.advance();
        this.listener(true);
      }
    });
    netConnection.on('netLost', () => {
      if (this.active && this.netConnection === netConnection) {
        const refreshRevision: number = this.stateClock.advance();
        this.refreshState(netConnection, refreshRevision);
      }
    });
    netConnection.on('netUnavailable', () => {
      if (this.active && this.netConnection === netConnection) {
        this.stateClock.advance();
        this.listener(false);
      }
    });
    netConnection.register((error: BusinessError) => {
      if (error) {
        return;
      }
      if (!this.active || this.netConnection !== netConnection) {
        netConnection.unregister(() => {});
        return;
      }
      this.registered = true;
    });
  }

  stop(): void {
    const netConnection: connection.NetConnection | undefined = this.netConnection;
    this.active = false;
    this.netConnection = undefined;
    this.stateClock.advance();
    if (netConnection === undefined || !this.registered) {
      this.registered = false;
      return;
    }

    this.registered = false;
    netConnection.unregister(() => {
      // Unregister is best-effort while the page is being destroyed.
    });
  }

  private canApplyQuery(
    expectedConnection: connection.NetConnection,
    capturedRevision: number
  ): boolean {
    return this.active &&
      this.netConnection === expectedConnection &&
      this.stateClock.accepts(capturedRevision);
  }

  private refreshState(
    expectedConnection: connection.NetConnection,
    capturedRevision: number
  ): void {
    connection.hasDefaultNet()
      .then((online: boolean) => {
        if (this.canApplyQuery(expectedConnection, capturedRevision)) {
          this.listener(online);
        }
      })
      .catch(() => {
        if (this.canApplyQuery(expectedConnection, capturedRevision)) {
          this.listener(false);
        }
      });
  }
}
