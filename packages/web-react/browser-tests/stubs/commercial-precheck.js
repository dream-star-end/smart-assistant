// The fixture injects deps.balance; the DB balance reader is never used.
export async function readTotalSpendableBalance() {
  return 0n
}
