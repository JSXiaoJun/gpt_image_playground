export function resolvePendingTimeoutMs(pendingTimeoutMs, upstreamTimeoutMs) {
  if (!Number.isFinite(pendingTimeoutMs) || pendingTimeoutMs <= 0) return 0
  if (!Number.isFinite(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) return pendingTimeoutMs
  return Math.max(pendingTimeoutMs, upstreamTimeoutMs)
}
