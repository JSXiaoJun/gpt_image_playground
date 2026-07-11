import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'

installMobileViewportGuards()

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', async () => {
      try {
        const cacheFixKey = 'gpt-image-playground.job-api-cache-fix-v1'
        if (window.localStorage.getItem(cacheFixKey) !== 'done') {
          const registrations = await navigator.serviceWorker.getRegistrations()
          await Promise.all(registrations.map((registration) => registration.unregister()))
          if ('caches' in window) {
            const keys = await window.caches.keys()
            await Promise.all(keys.filter((key) => key.startsWith('gpt-image-playground-')).map((key) => window.caches.delete(key)))
          }
          window.localStorage.setItem(cacheFixKey, 'done')
          if (navigator.serviceWorker.controller) {
            window.location.reload()
            return
          }
        }

        const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
          updateViaCache: 'none',
        })
        await registration.update()
      } catch (error) {
        console.error('Service worker registration failed:', error)
      }
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
