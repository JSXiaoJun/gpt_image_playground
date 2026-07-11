import { describe, expect, it } from 'vitest'
import { readUpstreamResponseBody } from './read-upstream-body.mjs'

function createOpenStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
    },
  })
}

describe('readUpstreamResponseBody', () => {
  it('finishes after receiving complete JSON without waiting for connection close', async () => {
    const response = new Response(createOpenStream(['  ', '{"data":[{"b64_json":"abc"}]}', '\n']), {
      headers: { 'content-type': 'application/json' },
    })

    await expect(readUpstreamResponseBody(response)).resolves.toEqual({
      body: '  {"data":[{"b64_json":"abc"}]}',
      completedBy: 'json',
    })
  })

  it('finishes after receiving an SSE completion event without waiting for connection close', async () => {
    const response = new Response(createOpenStream([
      ': heartbeat\n\n',
      'data: {"type":"image_generation.completed","b64_json":"abc"}\n\n',
    ]), {
      headers: { 'content-type': 'text/event-stream' },
    })

    const result = await readUpstreamResponseBody(response)
    expect(result.completedBy).toBe('sse')
    expect(result.body).toContain('image_generation.completed')
  })

  it('reads ordinary responses until the connection closes', async () => {
    const response = new Response('upstream error', {
      headers: { 'content-type': 'text/plain' },
    })

    await expect(readUpstreamResponseBody(response)).resolves.toEqual({
      body: 'upstream error',
      completedBy: null,
    })
  })
})
