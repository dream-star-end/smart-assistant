// The Responses terminal object remains the authority for final text and usage. Deltas are previews.
export interface ResponsesSource {
  headers?: Record<string, string | string[] | undefined>
  body: {
    text(): Promise<string>
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>
  }
}

export class ResponsesStreamError extends Error {}
export class ResponsesDeltaError extends Error {
  constructor(readonly original: unknown) {
    super('could not deliver response delta')
  }
}

export async function readResponses(
  source: ResponsesSource,
  onDelta?: (delta: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted()
  const contentType = source.headers?.['content-type']
  if (!String(contentType ?? '').includes('text/event-stream')) {
    try {
      return JSON.parse(await source.body.text())
    } catch (err) {
      if (err instanceof SyntaxError) throw new ResponsesStreamError('invalid JSON')
      throw err
    }
  }
  if (!source.body[Symbol.asyncIterator]) throw new ResponsesStreamError('missing stream body')
  const decoder = new TextDecoder()
  let buffered = ''
  const event = async (block: string): Promise<{ response: unknown } | null> => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data || data === '[DONE]') return null
    let value: Record<string, unknown>
    try {
      value = JSON.parse(data)
    } catch {
      throw new ResponsesStreamError('invalid SSE data')
    }
    if (!value || typeof value !== 'object') throw new ResponsesStreamError('invalid SSE event')
    if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') {
      signal?.throwIfAborted()
      if (onDelta && value.delta) {
        try {
          await onDelta(value.delta)
        } catch (err) {
          throw new ResponsesDeltaError(err)
        }
      }
    }
    if (value.type === 'response.completed') return { response: value.response }
    if (value.type === 'response.failed' || value.type === 'response.incomplete' || value.type === 'error')
      throw new ResponsesStreamError('upstream did not complete')
    return null
  }
  const body = source.body as AsyncIterable<Uint8Array>
  for await (const chunk of body) {
    signal?.throwIfAborted()
    buffered += decoder.decode(chunk, { stream: true })
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(buffered)
      if (!separator) break
      const block = buffered.slice(0, separator.index)
      buffered = buffered.slice(separator.index + separator[0].length)
      const done = await event(block)
      if (done) return done.response
    }
  }
  buffered += decoder.decode()
  if (buffered.trim()) {
    const done = await event(buffered)
    if (done) return done.response
  }
  throw new ResponsesStreamError('stream ended without response.completed')
}
