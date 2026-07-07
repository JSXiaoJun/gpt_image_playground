export const OPENAI_INTERRUPTED_ERROR = '页面刷新或关闭导致前端连接中断，接口可能仍在服务端生成，但当前页面无法取回结果。请重新生成。'

export function isInterruptedTaskError(error: string | null | undefined) {
  return Boolean(error && (error === OPENAI_INTERRUPTED_ERROR || error === '请求中断' || error.includes('前端连接中断')))
}
