// Local fixture used as auth.claudeCodeEntry. Reads only the spawn-env
// whitelist plus the case marker; never dumps the full environment.
const present = (key) => Object.prototype.hasOwnProperty.call(process.env, key)
const payload = {
  marker: 'OCV5-213-A9-SPAWN-ENV',
  pid: process.pid,
  ppid: process.ppid,
  case: process.env.OCV5_A9_CASE ?? '',
  OC_SESSION_KEY: present('OC_SESSION_KEY') ? (process.env.OC_SESSION_KEY ?? '') : null,
  OPENCLAUDE_SESSION_KEY: present('OPENCLAUDE_SESSION_KEY')
    ? (process.env.OPENCLAUDE_SESSION_KEY ?? '')
    : null,
  OPENCLAUDE_TRACE_ID: present('OPENCLAUDE_TRACE_ID')
    ? (process.env.OPENCLAUDE_TRACE_ID ?? '')
    : null,
  OPENCLAUDE_TRACE_ID_PRESENT: present('OPENCLAUDE_TRACE_ID'),
}
process.stderr.write(`${JSON.stringify(payload)}\n`)
process.exit(0)
