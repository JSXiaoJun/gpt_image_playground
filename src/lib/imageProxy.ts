import { isHttpUrl } from './imageApiShared'
import { readRuntimeEnv } from './runtimeEnv'

export function getDisplayImageUrl(url: string) {
  if (!isHttpUrl(url)) return url
  if (readRuntimeEnv(import.meta.env.VITE_DOCKER_DEPLOYMENT) !== 'true') return url
  return `/image-proxy?url=${encodeURIComponent(url)}`
}
