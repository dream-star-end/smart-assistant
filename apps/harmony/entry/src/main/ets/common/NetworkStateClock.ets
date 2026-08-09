/**
 * Orders asynchronous connectivity probes against newer system events.
 * NetConnection identity handles lifecycle replacement; this revision clock
 * handles out-of-order callbacks within one live connection.
 */
export class NetworkStateClock {
  private revision: number = 0;

  advance(): number {
    this.revision += 1;
    return this.revision;
  }

  capture(): number {
    return this.revision;
  }

  accepts(capturedRevision: number): boolean {
    return capturedRevision === this.revision;
  }
}
