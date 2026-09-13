import Database from 'better-sqlite3'
import { ReceiptDeliveryCoordinator } from './receiptDeliveryCoordinator.js'

export * from './receiptDeliveryCoordinator.js'

/** Existing Node consumer API; no changes to ordinary gateway SQLite stores. */
export class ReceiptDeliveryStore extends ReceiptDeliveryCoordinator {
  constructor(dbPath: string, now: () => number = Date.now) {
    super(dbPath, path => new Database(path, { fileMustExist: true }), now)
  }
}
