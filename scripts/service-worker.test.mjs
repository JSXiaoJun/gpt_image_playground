import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function loadFetchHandler() {
  const listeners = new Map()
  const response = { ok: true, clone: () => response }
  const context = {
    URL,
    caches: {
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
      open: async () => ({
        addAll: async () => undefined,
        put: async () => undefined,
      }),
    },
    fetch: async () => response,
    self: {
      location: { origin: 'https://example.com' },
      clients: { claim: async () => undefined },
      skipWaiting: () => undefined,
      addEventListener: (type, handler) => listeners.set(type, handler),
    },
  }

  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), context)
  return listeners.get('fetch')
}

function isIntercepted(handler, path, options = {}) {
  let intercepted = false
  handler({
    request: {
      method: 'GET',
      url: `https://example.com${path}`,
      mode: options.mode ?? 'cors',
      cache: options.cache ?? 'default',
    },
    respondWith: () => {
      intercepted = true
    },
  })
  return intercepted
}

describe('service worker cache policy', () => {
  it('does not intercept persistent job API requests', () => {
    const handler = loadFetchHandler()
    expect(isIntercepted(handler, '/api-jobs/task-1')).toBe(false)
    expect(isIntercepted(handler, '/api-jobs-health')).toBe(false)
    expect(isIntercepted(handler, '/api-jobs-logs')).toBe(false)
  })

  it('does not intercept requests that explicitly disable caching', () => {
    const handler = loadFetchHandler()
    expect(isIntercepted(handler, '/dynamic-data', { cache: 'no-store' })).toBe(false)
  })

  it('continues to cache application shell navigation and static assets', () => {
    const handler = loadFetchHandler()
    expect(isIntercepted(handler, '/', { mode: 'navigate' })).toBe(true)
    expect(isIntercepted(handler, '/assets/index.js')).toBe(true)
  })
})
