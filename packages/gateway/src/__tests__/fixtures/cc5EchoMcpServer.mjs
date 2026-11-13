#!/usr/bin/env node
// Tiny stdio MCP server used by the real-process tool-host test. It exposes one
// tool (`echo`) so the test can prove MCP tools reach the host through CCB's own
// client code instead of a mock.
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const tools = [
  {
    name: 'echo',
    description: 'Return the text it was given, prefixed with the fixture name.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let index
  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index).trim()
    buffered = buffered.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))

function handle(request) {
  if (request.id === undefined) return // notifications carry no reply
  const reply = (result) => send({ jsonrpc: '2.0', id: request.id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id: request.id, error: { code, message } })
  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cc5-echo-fixture', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools })
    case 'tools/call': {
      const name = request.params?.name
      const args = request.params?.arguments ?? {}
      if (name !== 'echo') return fail(-32602, `unknown tool: ${String(name)}`)
      if (typeof args.text !== 'string') return fail(-32602, 'text must be a string')
      return reply({
        content: [{ type: 'text', text: `fixture-echo:${args.text}` }],
        isError: false,
      })
    }
    default:
      return fail(-32601, `method not found: ${String(request.method)}`)
  }
}
