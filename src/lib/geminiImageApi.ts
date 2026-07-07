import type { ApiProfile } from '../types'
import { DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL } from './apiProfiles'
import { readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import {
  assertImageInputPayloadSize,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  MIME_MAP,
  normalizeBase64Image,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'

interface GeminiPart {
  text?: string
  inlineData?: {
    mimeType: string
    data: string
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[]
    }
  }>
  promptFeedback?: {
    blockReason?: string
  }
}

type GeminiImageSize = '1K' | '2K' | '4K'
type GeminiAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'

interface GeminiImageConfig {
  imageSize?: GeminiImageSize
  aspectRatio?: GeminiAspectRatio
}

function normalizeGeminiBaseUrl(baseUrl: string) {
  const trimmed = (baseUrl.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '')
  return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

function encodeModelName(model: string) {
  return (model.trim() || DEFAULT_GEMINI_MODEL)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function buildGeminiApiUrl(profile: ApiProfile, useApiProxy: boolean) {
  const path = `v1beta/models/${encodeModelName(profile.model)}:generateContent`
  if (useApiProxy) {
    return `${readClientDevProxyConfig()?.prefix ?? '/api-proxy'}/${path}`
  }

  const baseUrl = normalizeGeminiBaseUrl(profile.baseUrl)
  if (/:generateContent(?:\?|$)/.test(baseUrl)) return baseUrl
  if (baseUrl.endsWith('/v1beta')) return `${baseUrl}/models/${encodeModelName(profile.model)}:generateContent`
  if (baseUrl.endsWith('/v1beta/models')) return `${baseUrl}/${encodeModelName(profile.model)}:generateContent`
  return `${baseUrl}/${path}`
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function getGeminiImageSize(width: number, height: number): GeminiImageSize {
  const pixels = width * height
  if (pixels >= 6_000_000) return '4K'
  if (pixels >= 2_000_000) return '2K'
  return '1K'
}

function getGeminiAspectRatio(width: number, height: number): GeminiAspectRatio | undefined {
  const divisor = gcd(width, height)
  const ratio = `${width / divisor}:${height / divisor}`
  if (
    ratio === '1:1' ||
    ratio === '16:9' ||
    ratio === '9:16' ||
    ratio === '4:3' ||
    ratio === '3:4' ||
    ratio === '3:2' ||
    ratio === '2:3'
  ) {
    return ratio
  }
  return undefined
}

function buildGeminiImageConfig(size: string): GeminiImageConfig | undefined {
  const match = size.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return undefined

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined

  return {
    imageSize: getGeminiImageSize(width, height),
    aspectRatio: getGeminiAspectRatio(width, height),
  }
}

function dataUrlToInlinePart(dataUrl: string): GeminiPart {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) throw new Error('Gemini 参考图必须是 Base64 data URL')

  return {
    inlineData: {
      mimeType: match[1],
      data: match[2],
    },
  }
}

function getOutputFormatFromMime(mime: string): CallApiResult['actualParams'] {
  if (mime === 'image/jpeg') return { output_format: 'jpeg' }
  if (mime === 'image/webp') return { output_format: 'webp' }
  if (mime === 'image/png') return { output_format: 'png' }
  return undefined
}

function extractGeminiImages(payload: GeminiResponse, fallbackMime: string): CallApiResult {
  const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? []
  const imageParts = parts.filter((part) => part.inlineData?.data)
  const images = imageParts.map((part) =>
    normalizeBase64Image(part.inlineData?.data ?? '', part.inlineData?.mimeType || fallbackMime),
  )

  if (!images.length) {
    const blockReason = payload.promptFeedback?.blockReason
    const err = new Error(blockReason ? `Gemini 未返回图片，拦截原因：${blockReason}` : 'Gemini 没有返回可识别的图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const actualParamsList = imageParts.map((part) => getOutputFormatFromMime(part.inlineData?.mimeType || fallbackMime))
  return {
    images,
    actualParams: actualParamsList[0],
    actualParamsList,
  }
}

async function callGeminiImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.maskDataUrl) throw new Error('Gemini 暂不支持遮罩编辑，请移除遮罩后重试')

  const fallbackMime = MIME_MAP[opts.params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    assertImageInputPayloadSize(
      opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0),
    )
    const imageConfig = buildGeminiImageConfig(opts.params.size)

    const response = await fetch(buildGeminiApiUrl(profile, useApiProxy), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(profile.apiKey.trim() ? { 'x-goog-api-key': profile.apiKey.trim() } : {}),
      },
      cache: 'no-store',
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            ...opts.inputImageDataUrls.map(dataUrlToInlinePart),
            { text: opts.prompt },
          ],
        }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(imageConfig ? { imageConfig } : {}),
        },
      }),
      signal: controller.signal,
    })

    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const result = extractGeminiImages(await response.json() as GeminiResponse, fallbackMime)
    if (!imageConfig) return result
    return {
      ...result,
      actualParams: { ...result.actualParams, size: opts.params.size },
      actualParamsList: result.actualParamsList?.map((params) => ({ ...params, size: opts.params.size })),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function callGeminiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) return callGeminiImageApiSingle(opts, profile)

  const results = await Promise.allSettled(
    Array.from({ length: n }).map(() => callGeminiImageApiSingle({
      ...opts,
      params: {
        ...opts.params,
        n: 1,
      },
    }, profile)),
  )
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<CallApiResult> => result.status === 'fulfilled')
    .map((result) => result.value)
  const failedRequests = results.flatMap((result, requestIndex) =>
    result.status === 'rejected'
      ? [{ requestIndex, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
      : [],
  )

  if (!successfulResults.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有 Gemini 并发请求均失败')
  }

  const images = successfulResults.flatMap((result) => result.images)
  const actualParamsList = successfulResults.flatMap((result) => result.actualParamsList ?? result.images.map(() => result.actualParams))
  return {
    images,
    actualParams: {
      ...successfulResults[0].actualParams,
      n: images.length,
    },
    actualParamsList,
    ...(failedRequests.length ? { failedRequests } : {}),
  }
}
