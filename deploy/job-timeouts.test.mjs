import { describe, expect, it } from 'vitest'
import { resolvePendingTimeoutMs } from './job-timeouts.mjs'

describe('persistent job timeouts', () => {
  it('does not expire the pending phase before the configured request timeout', () => {
    expect(resolvePendingTimeoutMs(180_000, 600_000)).toBe(600_000)
  })

  it('keeps the pending fallback when no request timeout is configured', () => {
    expect(resolvePendingTimeoutMs(180_000, 0)).toBe(180_000)
  })

  it('respects a disabled pending timeout', () => {
    expect(resolvePendingTimeoutMs(0, 600_000)).toBe(0)
  })
})
