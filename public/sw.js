const CACHE_NAME = 'gpt-image-playground-v0.6.44'
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './pwa-icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // API 和显式禁用缓存的请求必须直连网络，否则任务轮询会一直读到首次缓存的 running 状态。
  if (
    request.cache === 'no-store' ||
    url.pathname.startsWith('/api-jobs/') ||
    url.pathname === '/api-jobs-health' ||
    url.pathname === '/api-jobs-logs' ||
    url.pathname.startsWith('/api-proxy/') ||
    url.pathname === '/image-proxy'
  ) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy))
          return response
        })
        .catch(() => caches.match('./index.html')),
    )
    return
  }

  // 仅缓存构建后的静态资源和 PWA 文件，不缓存其他动态 GET 响应。
  if (
    !url.pathname.includes('/assets/') &&
    !url.pathname.endsWith('/manifest.webmanifest') &&
    !url.pathname.endsWith('/pwa-icon.svg')
  ) return

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
