function getSseData(block) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
    .trim()
}

function hasCompletedSseEvent(body) {
  const blocks = body.split(/\r?\n\r?\n/)
  blocks.pop()

  return blocks.some((block) => {
    const data = getSseData(block)
    if (data === '[DONE]') return true
    if (!data) return false

    try {
      const event = JSON.parse(data)
      const type = typeof event?.type === 'string' ? event.type : ''
      const object = typeof event?.object === 'string' ? event.object : ''
      return type === 'image_generation.completed' ||
        type === 'image_edit.completed' ||
        type === 'response.completed' ||
        type.endsWith('.failed') ||
        object === 'image.generation.result' ||
        object === 'image.edit.result' ||
        Boolean(event?.error)
    } catch {
      return false
    }
  })
}

function isCompleteJson(body) {
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

export async function readUpstreamResponseBody(response) {
  if (!response.body) return { body: '', completedBy: null }

  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  const isJson = contentType.includes('application/json')
  const isSse = contentType.includes('text/event-stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      body += decoder.decode()
      return { body, completedBy: null }
    }

    body += decoder.decode(value, { stream: true })
    const completedBy = isJson && isCompleteJson(body.trim())
      ? 'json'
      : isSse && hasCompletedSseEvent(body)
        ? 'sse'
        : null
    if (!completedBy) continue

    await reader.cancel('complete upstream response received')
    body += decoder.decode()
    return { body, completedBy }
  }
}
