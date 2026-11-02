import { lstatSync, readFileSync } from 'node:fs'
import { requireRemote } from '@openclaude/protocol/agentRemote'
/** The actual Node process must own the exclusive flock (not a TTL or JSON claim). */
export function assertNativeWriterLock(path: string): void {
  requireRemote(process.platform === 'linux', 'native-lock-platform')
  const stat = lstatSync(path, { bigint: true })
  requireRemote(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'native-lock-file')
  const major = ((stat.dev & 0xfff00n) >> 8n) | ((stat.dev & 0xfffff00000000000n) >> 32n)
  const minor = (stat.dev & 0xffn) | ((stat.dev & 0xffffff00000n) >> 12n)
  const held = readFileSync('/proc/locks', 'utf8')
    .split('\n')
    .some((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE' || Number(fields[4]) !== process.pid)
        return false
      const identity = fields[5]?.split(':')
      return (
        identity?.length === 3 &&
        BigInt(`0x${identity[0]}`) === major &&
        BigInt(`0x${identity[1]}`) === minor &&
        identity[2] === String(stat.ino)
      )
    })
  requireRemote(held, 'native-lock-not-held')
}
