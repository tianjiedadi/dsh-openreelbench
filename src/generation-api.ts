/** Small, provider-neutral HTTP adapters for image, video and speech APIs. */
import { createHash, randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { promises as fs } from 'node:fs'

import type { ApiEndpointConfig, GenerationConfig, VoiceApiConfig, VisualApiConfig } from './config.js'
import { externalReference, readVisualReference, type VisualReferences } from './visual-references.js'
import type { ProjectLayout } from './project.js'
import { ensureDir, readJson, resolveInProject, toProjectRelative, writeJsonAtomic } from './project.js'
import { DASHSCOPE_CLONE_MODEL } from './voice-catalog.js'
import { normalizeApiUrl } from './api-url.js'

export class GenerationApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationApiError'
  }
}

export interface GeneratedFile {
  path: string
  format: string
  bytes: number
}

export function resolveApiKey(config: ApiEndpointConfig): string {
  const envName = (config.apiKeyEnv ?? '').trim()
  return (config.apiKey ?? '').trim() || (envName === '' ? '' : process.env[envName] ?? '')
}

export function endpointOf(config: ApiEndpointConfig, kind: string, modelRequired = true): string {
  const endpoint = config.endpoint.trim()
  if (endpoint === '') throw new GenerationApiError(kind + ' API endpoint is not configured')
  if (modelRequired && config.model.trim() === '') throw new GenerationApiError(kind + ' API model is not configured')
  // Complete endpoints keep their original meaning. A gateway root or /v1
  // may also be supplied; only these unambiguous base paths are expanded.
  let url: URL
  try { url = new URL(normalizeApiUrl(endpoint)) } catch { throw new GenerationApiError(kind + ' API 地址不是有效 URL：' + endpoint) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new GenerationApiError('API 地址必须使用 HTTP(S)。')
  const path = url.pathname.replace(/\/+$/, '')
  if ((path === '' || /\/v\d+$/i.test(path)) && ['image', 'video', 'voice'].includes(kind)) {
    const prefix = path === '' ? '/v1' : path
    url.pathname = prefix + (kind === 'voice' ? '/audio/speech' : kind === 'image' ? '/images/generations' : '/videos')
    return url.href
  }
  return url.href
}

export function apiHeaders(config: ApiEndpointConfig): Record<string, string> {
  const key = resolveApiKey(config)
  return {
    accept: 'application/json, audio/*, video/*, image/*',
    'content-type': 'application/json',
    ...(key === '' ? {} : { authorization: 'Bearer ' + key }),
  }
}

export function apiErrorDetail(config: ApiEndpointConfig, value: unknown): string {
  const key = resolveApiKey(config)
  const detail = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return (key.length > 3 ? detail.replaceAll(key, '[redacted]') : detail).slice(0, 500)
}

export function dashscopeSpeechEndpoint(config: VoiceApiConfig): string {
  const raw = config.endpoint.trim() || 'https://dashscope.aliyuncs.com'
  let url: URL
  try { url = new URL(raw) } catch { throw new GenerationApiError('百炼语音 API 地址不是有效 URL。') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new GenerationApiError('API 地址必须使用 HTTP(S)。')
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/api/v1' || /^\/compatible-mode\/v1(?:\/audio\/speech)?$/.test(path)) {
    url.pathname = '/api/v1/services/aigc/multimodal-generation/generation'
  }
  return url.href
}

async function readResponse(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('json') || type.includes('text/')) {
    const text = await response.text()
    try { return JSON.parse(text) as unknown } catch { return text }
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function post(
  config: ApiEndpointConfig,
  kind: string,
  payload: Record<string, unknown>,
  modelRequired = true,
): Promise<unknown> {
  const endpoint = endpointOf(config, kind, modelRequired)
  const timeout = AbortSignal.timeout(15 * 60 * 1000)
  let response: Response
  try {
    response = await fetch(endpoint, { method: 'POST', headers: apiHeaders(config), body: JSON.stringify(payload), signal: timeout })
  } catch (error) {
    throw new GenerationApiError(kind + ' API 请求失败（' + endpoint + '）：' + apiErrorDetail(config, (error as Error).message)
      + (kind === 'video' ? '。提交结果未知，请先在中转站任务记录中核对，勿直接重复生成。' : ''))
  }
  const value = await readResponse(response)
  if (!response.ok) {
    if (kind === 'video' && response.status === 502 && value !== null && typeof value === 'object') {
      const result = value as Record<string, unknown>
      if (result.code === 'task_submission_unknown' && typeof result.data === 'string' && result.data !== '') return { id: result.data, status: 'submitted' }
    }
    const hint = response.status === 413 && kind === 'video'
      ? ' 参考图片超过中转站请求体限制，请缩小尺寸或压缩为 JPEG 后重新上传。'
      : response.status === 404 && kind.startsWith('voice')
      ? ' 请核对完整接口路径。使用百炼时请选择「阿里云百炼原生」协议；兼容路径不提供 TTS。'
      : response.status === 404 ? ' 请按中转站说明填写完整生成接口地址。' : ''
    throw new GenerationApiError(kind + ' API 返回 HTTP ' + response.status + '（请求地址：' + endpoint + '）：' + apiErrorDetail(config, value) + hint)
  }
  return value
}

function mediaReference(value: unknown): string | Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return /^(https?:\/\/|data:)/i.test(value) || (value.length > 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) ? value : undefined
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = mediaReference(entry)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of [
    'url', 'uri', 'download_url', 'downloadUrl', 'result_url', 'resultUrl',
    'output_url', 'outputUrl', 'audio_url', 'audioUrl', 'video_url', 'videoUrl',
    'image_url', 'imageUrl', 'media_url', 'mediaUrl', 'b64_json', 'base64', 'audio_base64', 'audioBase64',
    'video_base64', 'videoBase64', 'image_base64', 'imageBase64', 'data', 'content',
    'audio', 'video', 'image', 'output', 'file', 'files', 'artifact', 'artifacts',
    'result', 'response', 'task', 'choices', 'videos',
  ]) {
    const found = mediaReference(record[key])
    if (found !== undefined) return found
  }
  return undefined
}

function extension(kind: 'image' | 'video' | 'voice', contentType = ''): string {
  if (contentType.includes('mp4')) return 'mp4'
  if (contentType.includes('webm')) return 'webm'
  if (contentType.includes('wav')) return 'wav'
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('png')) return 'png'
  if (kind === 'video') return 'mp4'
  if (kind === 'voice') return 'mp3'
  return 'png'
}

async function bytesFromReference(reference: string | Uint8Array, kind: 'image' | 'video' | 'voice', config?: ApiEndpointConfig): Promise<{ bytes: Uint8Array; ext: string }> {
  if (reference instanceof Uint8Array) return { bytes: reference, ext: extension(kind) }
  if (reference.startsWith('data:')) {
    const comma = reference.indexOf(',')
    if (comma < 0) throw new GenerationApiError('API returned an invalid data URL')
    const head = reference.slice(5, comma)
    const body = reference.slice(comma + 1)
    const binary = head.includes(';base64')
      ? Uint8Array.from(Buffer.from(body, 'base64'))
      : Uint8Array.from(Buffer.from(decodeURIComponent(body), 'utf8'))
    return { bytes: binary, ext: extension(kind, head) }
  }
  // OpenAI compatible APIs often return b64_json without a data URL prefix.
  // Treat a long base64-looking value as bytes before attempting a network URL.
  if (!/^https?:\/\//i.test(reference) && reference.length > 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(reference)) {
    return { bytes: Uint8Array.from(Buffer.from(reference, 'base64')), ext: extension(kind) }
  }
  let response: Response
  const mediaOrigin = new URL(reference).origin
  let queryOrigin = ''
  if (kind === 'video' && config?.pollUrl.trim()) {
    try { queryOrigin = new URL(config.pollUrl).origin } catch { /* Invalid query URLs are reported by the poller. */ }
  }
  const sameApi = config !== undefined && (mediaOrigin === new URL(config.endpoint).origin || mediaOrigin === queryOrigin)
  const key = sameApi && config !== undefined ? resolveApiKey(config) : ''
  try { response = await fetch(reference, { headers: key === '' ? {} : { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15 * 60 * 1000) }) } catch (error) {
    throw new GenerationApiError('API media download failed: ' + (error as Error).message)
  }
  if (!response.ok) throw new GenerationApiError('API media download returned HTTP ' + response.status)
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    ext: extension(kind, response.headers.get('content-type') ?? ''),
  }
}

const taskIdKeys = ['id', 'task_id', 'taskId', 'request_id', 'requestId', 'job_id', 'jobId'] as const
const taskContainerKeys = ['data', 'task', 'output', 'result', 'response'] as const
const successStates = ['success', 'succeeded', 'completed', 'complete', 'done', 'finished']
const failedStates = ['failed', 'failure', 'error', 'cancelled', 'canceled', 'unknown']

function taskId(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = taskId(entry, depth + 1)
      if (found !== '') return found
    }
    return ''
  }
  const record = value as Record<string, unknown>
  for (const key of taskIdKeys) {
    if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) return String(record[key])
  }
  for (const key of taskContainerKeys) {
    const found = taskId(record[key], depth + 1)
    if (found !== '') return found
  }
  return ''
}

function taskState(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = taskState(entry, depth + 1)
      if (found !== '') return found
    }
    return ''
  }
  const record = value as Record<string, unknown>
  for (const key of ['status', 'state', 'task_status', 'taskStatus']) {
    if (typeof record[key] === 'string' && record[key] !== '') return (record[key] as string).toLowerCase()
  }
  for (const key of taskContainerKeys) {
    const found = taskState(record[key], depth + 1)
    if (found !== '') return found
  }
  return ''
}

function normalizePollUrl(config: VisualApiConfig, endpoint: string): { url: string; explicit: boolean } {
  const configured = config.pollUrl
  const explicit = configured.trim() !== ''
  const generated = new URL(endpoint)
  const generatedPath = generated.pathname.replace(/\/+$/, '')
  const xai = visualProtocol(config, 'video') === 'xai'
  const generatedCollection = !xai && /\/video\/generations$/i.test(generatedPath) ? 'video/generations' : 'videos'
  if (!explicit) {
    const pollEndpoint = new URL(generated.href)
    if (xai) pollEndpoint.pathname = generatedPath.replace(/\/videos\/generations$/i, '/videos')
    if (!/\/(videos|video\/generations)$/i.test(pollEndpoint.pathname.replace(/\/+$/, ''))) return { url: '', explicit: false }
    pollEndpoint.pathname = pollEndpoint.pathname.replace(/\/+$/, '') + '/{id}'
    return { url: pollEndpoint.href.replace(/%7Bid%7D/ig, '{id}'), explicit: false }
  }
  let url: URL
  try { url = new URL(configured.trim()) } catch { throw new GenerationApiError('视频任务查询地址不是有效 URL：' + configured.trim()) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new GenerationApiError('视频任务查询地址必须使用 HTTP(S)。')
  if (xai) url.pathname = url.pathname.replace(/\/videos\/generations(?=\/|$)/i, '/videos')
  if (url.href.includes('{id}') || /%7Bid%7D/i.test(url.href)) {
    return { url: url.href.replace(/%7Bid%7D/ig, '{id}'), explicit: true }
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || /\/v\d+$/i.test(path)) url.pathname = (path || '/v1') + '/' + generatedCollection + '/{id}'
  else if (/\/(videos|video\/generations)$/i.test(path)) url.pathname = path + '/{id}'
  else url.pathname = path + '/{id}'
  return { url: url.href.replace(/%7Bid%7D/ig, '{id}'), explicit: true }
}

function xaiRelativeVideoUrl(value: unknown, baseUrl: string, depth = 0): string | undefined {
  if (depth > 4 || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const video = record.video !== null && typeof record.video === 'object' ? record.video as Record<string, unknown> : {}
  const url = video.url
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return new URL(url, baseUrl).href
  for (const key of taskContainerKeys) {
    const found = xaiRelativeVideoUrl(record[key], baseUrl, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

async function pollVideo(layout: ProjectLayout, config: VisualApiConfig, first: unknown): Promise<unknown> {
  const reference = mediaReference(first)
  if (reference !== undefined) return first
  const id = taskId(first)
  if (id === '') throw new GenerationApiError('视频 API 已返回响应，但没有识别到视频地址或任务 ID。请检查中转站的视频提交协议，或在“视频任务查询地址”填写带 {id} 的查询地址。原始响应：' + apiErrorDetail(config, first))
  const endpoint = endpointOf(config, 'video')
  const taskPath = join(layout.workDir, 'api-video-' + createHash('sha256').update(id).digest('hex').slice(0, 16) + '.json')
  const submitted = { id, model: config.model, endpoint, status: 'submitted', created_at: new Date().toISOString() }
  await ensureDir(layout.workDir)
  await writeJsonAtomic(taskPath, submitted)
  let poll: ReturnType<typeof normalizePollUrl>
  try { poll = normalizePollUrl(config, endpoint) }
  catch (error) { throw new GenerationApiError(apiErrorDetail(config, (error as Error).message) + '。视频任务已提交，ID：' + id + '；记录已保存到项目 work 目录，勿重复提交。') }
  const raw = poll.url
  await writeJsonAtomic(taskPath, { ...submitted, poll_url: raw })
  if (raw === '') throw new GenerationApiError('视频任务已提交，ID：' + id + '。请配置查询地址后查询原任务，勿重复提交。')
  const url = raw.replaceAll('{id}', encodeURIComponent(id))
  if (!poll.explicit && new URL(url).origin !== new URL(endpoint).origin) throw new GenerationApiError('自动推导的视频查询地址与生成地址不同源，视频任务 ID：' + id + '；请填写中转站提供的完整查询地址。')
  const deadline = Date.now() + 30 * 60 * 1000
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 20_000 + attempt * 3000)))
    let response: Response
    try { response = await fetch(url, { headers: apiHeaders(config), signal: AbortSignal.timeout(60_000) }) }
    catch { continue } // Retry the GET only; generation POST is never retried.
    const value = await readResponse(response)
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) continue
      if (response.status === 400 && value !== null && typeof value === 'object' && (value as Record<string, unknown>).code === 'task_not_exist' && attempt < 4) continue
      throw new GenerationApiError('视频查询 HTTP ' + response.status + '，任务 ID：' + id + '：' + apiErrorDetail(config, value))
    }
    const state = taskState(value)
    await writeJsonAtomic(taskPath, { ...submitted, poll_url: raw, status: state, updated_at: new Date().toISOString() })
    if (failedStates.includes(state)) {
      throw new GenerationApiError('视频任务未成功，ID：' + id + '：' + apiErrorDetail(config, value))
    }
    const media = mediaReference(value) ?? (visualProtocol(config, 'video') === 'xai' ? xaiRelativeVideoUrl(value, url) : undefined)
    if (successStates.includes(state) || (state === '' && media !== undefined)) {
      if (media !== undefined) return { video: media }
      const download = new URL(url)
      if (/\/videos\/[^/]+$/i.test(download.pathname) || /\/video\/generations\/[^/]+$/i.test(download.pathname)) {
        download.pathname = download.pathname.replace(/\/+$/, '') + '/content'
        return { url: download.href }
      }
      const fallback = new URL(endpoint)
      if (/\/video\/generations\/?$/.test(fallback.pathname)) fallback.pathname = fallback.pathname.replace(/\/video\/generations\/?$/, '/videos')
      if (/\/videos\/?$/.test(fallback.pathname)) {
        fallback.pathname = fallback.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(id) + '/content'
        return { url: fallback.href }
      }
      throw new GenerationApiError('视频任务已完成但没有下载地址，ID：' + id)
    }
  }
  throw new GenerationApiError('视频任务已提交，正在查询任务 ID：' + id + '；等待超时。任务记录已保存到项目 work 目录，请查询原任务，勿重复提交。')
}

async function writeFile(layout: ProjectLayout, directory: string, prefix: string, kind: 'image' | 'video' | 'voice', reference: string | Uint8Array, config?: ApiEndpointConfig): Promise<GeneratedFile> {
  const downloaded = await bytesFromReference(reference, kind, config)
  const ext = kind === 'voice' ? audioExtension(downloaded.bytes, downloaded.ext) : downloaded.ext
  if (kind === 'voice' && ext === 'wav') repairWavLengths(downloaded.bytes)
  await ensureDir(directory)
  const absolute = join(directory, prefix + '-' + randomUUID() + '.' + ext)
  await fs.writeFile(absolute, downloaded.bytes)
  return { path: toProjectRelative(layout, absolute), format: ext, bytes: downloaded.bytes.byteLength }
}

function audioExtension(bytes: Uint8Array, fallback: string): string {
  const magic = Buffer.from(bytes.subarray(0, 12))
  if (magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  if (magic.toString('ascii', 0, 3) === 'ID3') return 'mp3'
  if (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0) {
    return (bytes[1] & 0x06) === 0 ? 'aac' : 'mp3'
  }
  if (magic.toString('ascii', 0, 4) === 'fLaC') return 'flac'
  if (magic.toString('ascii', 0, 4) === 'OggS') return 'ogg'
  if (magic.toString('ascii', 4, 8) === 'ftyp') return 'm4a'
  return fallback === 'png' ? 'mp3' : fallback
}

/** DashScope may emit streaming WAV placeholder sizes even in a downloaded file. */
function repairWavLengths(bytes: Uint8Array): void {
  if (bytes.length < 12) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(4, bytes.length - 8, true)
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii')
    const size = view.getUint32(offset + 4, true)
    const remaining = bytes.length - offset - 8
    if (id === 'data' && (size === 0 || size > remaining)) {
      view.setUint32(offset + 4, remaining, true)
      return
    }
    if (size > remaining) throw new GenerationApiError('语音 API 返回的 WAV 块不完整：' + id)
    offset += 8 + size + (size % 2)
  }
}

function audioMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.flac': return 'audio/flac'
    case '.ogg':
    case '.oga': return 'audio/ogg'
    case '.opus': return 'audio/opus'
    case '.webm':
    case '.weba': return 'audio/webm'
    case '.aac': return 'audio/aac'
    default: return 'audio/mpeg'
  }
}

/**
 * Read project-local reference clips into data URLs. A model API cannot reach
 * the browser's `/openreel/media` URL, while a data URL works for both a local
 * endpoint and a remote provider. The raw base64 values are returned too for
 * APIs that have a dedicated base64 field.
 */
async function voiceReferencePayload(
  layout: ProjectLayout,
  paths: readonly string[] | undefined,
): Promise<{ urls: string[]; base64: string[] }> {
  const urls: string[] = []
  const base64: string[] = []
  for (const relative of paths ?? []) {
    const absolute = resolveInProject(layout, relative)
    let bytes: Buffer
    try {
      bytes = await fs.readFile(absolute)
    } catch (error) {
      throw new GenerationApiError('voice reference could not be read: ' + relative + ' (' + (error as Error).message + ')')
    }
    if (bytes.length === 0) throw new GenerationApiError('voice reference is empty: ' + relative)
    const encoded = bytes.toString('base64')
    base64.push(encoded)
    urls.push('data:' + audioMime(relative) + ';base64,' + encoded)
  }
  return { urls, base64 }
}

function visualProtocol(config: VisualApiConfig, kind: 'image' | 'video'): 'json' | 'multipart' | 'kkrich' | 'xai' {
  if (config.visualProtocol && config.visualProtocol !== 'auto') return config.visualProtocol
  if (kind === 'video' && new URL(config.endpoint).hostname === 'api.kkrich.ltd'
    && /^(sd_2\.[05]_|seedance-2\.5$)/.test(config.model)) return 'kkrich'
  if (kind === 'video' && /grok-imagine-video/i.test(config.model)) return 'xai'
  return kind === 'image' ? 'multipart' : 'json'
}

function referenceEndpoint(config: VisualApiConfig, kind: 'image' | 'video'): string {
  const base = config.referenceEndpoint?.trim() || config.endpoint
  return endpointOf({ ...config, endpoint: normalizeApiUrl(base) }, kind)
}

function selectedReferences(input?: VisualReferences): { images: string[]; videos: string[] } {
  if (input?.input !== 'reference') return { images: [], videos: [] }
  if (input.images.length + input.videos.length === 0) throw new GenerationApiError('参考生成模式至少要选择一个参考素材。')
  return { images: input.images, videos: input.videos }
}

async function jsonReferences(layout: ProjectLayout, config: VisualApiConfig, references: { images: string[]; videos: string[] }): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [field, values] of [[config.imageField?.trim() || 'reference_image', references.images], [config.videoField?.trim() || 'reference_video', references.videos]] as const) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) || ['model', 'prompt', 'size', 'seconds', 'duration', '__proto__', 'constructor'].includes(field)) throw new GenerationApiError('参考字段名无效：' + field)
    const encoded = []
    for (const value of values) {
      if (externalReference(value)) encoded.push(value)
      else {
        const file = await readVisualReference(layout, value)
        const data = Buffer.from(file.bytes).toString('base64')
        encoded.push(config.referenceEncoding === 'base64' ? data : 'data:' + file.mime + ';base64,' + data)
      }
    }
    if (encoded.length > 0) result[field] = encoded.length === 1 ? encoded[0] : encoded
  }
  return result
}

async function postVisualMultipart(layout: ProjectLayout, config: VisualApiConfig, kind: 'image' | 'video', payload: Record<string, unknown>, references: { images: string[]; videos: string[] }): Promise<unknown> {
  let endpoint = referenceEndpoint(config, kind)
  if (kind === 'image') endpoint = endpoint.replace(/\/images\/generations(?=\?|$)/, '/images/edits')
  const form = new FormData()
  for (const [field, value] of Object.entries(payload)) if (value !== undefined) form.append(field, String(value))
  for (const [field, values, mediaKind] of [[config.imageField?.trim() || (kind === 'image' ? references.images.length > 1 ? 'image[]' : 'image' : 'input_reference'), references.images, 'image'], [config.videoField?.trim() || 'reference_video', references.videos, 'video']] as const) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?$/.test(field) || ['model', 'prompt', 'size', 'seconds', 'duration'].includes(field)) throw new GenerationApiError('参考字段名无效：' + field)
    for (const value of values) {
      if (value.startsWith('assetId://')) form.append(field, value)
      else {
        const file = externalReference(value) ? await downloadMultipartReference(value, mediaKind) : await readVisualReference(layout, value)
        form.append(field, new Blob([Uint8Array.from(file.bytes)], { type: file.mime }), file.name)
      }
    }
  }
  const headers = apiHeaders(config)
  delete headers['content-type']
  let response: Response
  try { response = await fetch(endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(15 * 60 * 1000) }) }
  catch (error) { throw new GenerationApiError('参考生成请求失败：' + apiErrorDetail(config, (error as Error).message) + '。若为视频，请确认任务状态后再重试。') }
  const value = await readResponse(response)
  if (!response.ok) throw new GenerationApiError('参考生成 HTTP ' + response.status + '（' + endpoint + '）：' + apiErrorDetail(config, value))
  return value
}

async function downloadMultipartReference(url: string, kind: 'image' | 'video'): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || response.body === null) throw new GenerationApiError('无法读取参考地址，HTTP ' + response.status)
  const limit = 20 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new GenerationApiError('参考素材超过 20 MB。') }
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]!
  if (!mime.startsWith(kind + '/')) { await response.body.cancel(); throw new GenerationApiError('参考地址没有返回有效的' + (kind === 'image' ? '图片' : '视频') + '。') }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); throw new GenerationApiError('参考素材超过 20 MB。') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  if (size === 0) throw new GenerationApiError('参考素材为空。')
  return { name: 'reference.' + extension(kind, mime), mime, bytes: new Uint8Array(Buffer.concat(chunks)) }
}

function kkrichPayload(config: VisualApiConfig, input: { prompt: string; width: number; height: number; seconds: number }, references: { images: string[]; videos: string[] }): Record<string, unknown> {
  const model = config.model
  const is25 = /^(sd_2\.5_|seedance-2\.5$)/.test(model)
  const max = is25 ? 30 : 15
  if (!Number.isInteger(input.seconds) || input.seconds < 4 || input.seconds > max) throw new GenerationApiError('当前 Seedance 模型时长必须是 4–' + max + ' 秒整数，请在生成参数中设置固定秒数。')
  if (references.images.length > 1 || references.videos.length > 1) throw new GenerationApiError('此 Seedance 接口最多支持一张参考图片和一段参考视频。')
  const needsVideo = model.endsWith('_with_video_ref')
  if (needsVideo && references.videos.length !== 1) throw new GenerationApiError('所选模型要求一段参考视频，请选择参考模式并添加视频。')
  if (!needsVideo && references.videos.length > 0) throw new GenerationApiError('所选模型不支持参考视频，请从模型列表选择带 _with_video_ref 的模型。')
  for (const value of [...references.images, ...references.videos]) if (!externalReference(value)) throw new GenerationApiError('KKRICH Seedance 只接受公开 HTTPS 地址或平台签发的 assetId://，不接受本地上传文件或 Base64。请添加可公开读取的参考地址。')
  const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
  const ratio = ratios.find(r => { const [w, h] = r.split(':').map(Number); return Math.abs(input.width / input.height - w! / h!) < 0.001 })
  if (ratio === undefined) throw new GenerationApiError('此 Seedance 接口支持 16:9、9:16、1:1、4:3、3:4、21:9。请调整宽高比例；输出分辨率由所选模型决定。')
  if (Buffer.byteLength(input.prompt, 'utf8') > 8192 || input.prompt.includes('\0')) throw new GenerationApiError('此接口提示词须不超过 8192 字节，且不能包含 NUL。')
  return {
    model, prompt: input.prompt, duration: input.seconds, ratio, generate_audio: config.generateAudio === true,
    ...(references.images.length === 0 ? {} : { reference_image: references.images[0] }),
    ...(references.videos.length === 0 ? {} : { reference_video: references.videos[0] }),
  }
}

async function xaiReferenceImage(layout: ProjectLayout, value: string): Promise<string> {
  if (/^https:\/\//i.test(value)) return value
  if (/^assetId:\/\//i.test(value)) throw new GenerationApiError('xAI Grok 视频参考图只接受公开 HTTPS 地址或本地图片，暂不支持 assetId://。')
  const file = await readVisualReference(layout, value)
  if (!file.mime.startsWith('image/')) throw new GenerationApiError('xAI Grok 视频参考素材必须是图片。')
  return 'data:' + file.mime + ';base64,' + Buffer.from(file.bytes).toString('base64')
}

async function xaiVideoPayload(
  layout: ProjectLayout,
  config: VisualApiConfig,
  input: { prompt: string; width: number; height: number; seconds: number },
  references: { images: string[]; videos: string[] },
): Promise<Record<string, unknown>> {
  if (input.prompt.trim() === '') throw new GenerationApiError('xAI Grok 视频提示词不能为空。')
  if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 15) {
    throw new GenerationApiError('xAI Grok 视频时长必须是 1–15 秒整数，请在生成参数中设置固定秒数。')
  }
  if (references.videos.length > 0) throw new GenerationApiError('xAI Grok Imagine 当前协议只支持参考图片，不支持参考视频。')
  if (references.images.length > 1) throw new GenerationApiError('xAI Grok Imagine 最多支持一张参考图片。')
  const ratio = ['16:9', '9:16', '1:1'].find(value => {
    const [width, height] = value.split(':').map(Number)
    return Math.abs(input.width / input.height - width! / height!) < 0.001
  }) ?? (input.width >= input.height ? '16:9' : '9:16')
  return {
    model: config.model,
    prompt: input.prompt,
    duration: input.seconds,
    resolution: config.resolution === '480p' ? '480p' : '720p',
    aspect_ratio: ratio,
    ...(references.images.length === 0 ? {} : { image: { url: await xaiReferenceImage(layout, references.images[0]!) } }),
  }
}

export async function generateImage(
  layout: ProjectLayout,
  config: GenerationConfig,
  input: { prompt: string; width: number; height: number; references?: VisualReferences },
): Promise<GeneratedFile> {
  const endpoint = config.api.image
  const references = selectedReferences(input.references)
  const gptImage = /^\s*(?:gpt[-_ ]?image|chatgpt[-_ ]?image)/i.test(endpoint.model)
  const payload = {
    model: endpoint.model,
    prompt: input.prompt,
    size: input.width + 'x' + input.height,
    ...(gptImage ? {} : { width: input.width, height: input.height }),
    n: 1,
  }
  const value = references.images.length > 0
    ? visualProtocol(endpoint, 'image') === 'json'
      ? await post({ ...endpoint, endpoint: referenceEndpoint(endpoint, 'image').replace(/\/images\/generations(?=\?|$)/, '/images/edits') }, 'image', { ...payload, ...await jsonReferences(layout, endpoint, references) })
      : await postVisualMultipart(layout, endpoint, 'image', payload, references)
    : await post(endpoint, 'image', payload)
  const reference = mediaReference(value)
  if (reference === undefined) throw new GenerationApiError('image API response did not contain a media URL or base64 field')
  return writeFile(layout, layout.imagesDir, 'image', 'image', reference, endpoint)
}

export async function generateVideo(
  layout: ProjectLayout,
  config: GenerationConfig,
  input: { prompt: string; width: number; height: number; seconds: number; references?: VisualReferences },
): Promise<GeneratedFile> {
  const endpoint = config.api.video
  const references = selectedReferences(input.references)
  const protocol = visualProtocol(endpoint, 'video')
  const payload = protocol === 'kkrich' ? kkrichPayload(endpoint, input, references)
    : protocol === 'xai' ? await xaiVideoPayload(layout, endpoint, input, references)
      : { model: endpoint.model, prompt: input.prompt, size: input.width + 'x' + input.height, seconds: input.seconds }
  const connection = references.images.length + references.videos.length > 0
    ? { ...endpoint, endpoint: referenceEndpoint(endpoint, 'video') } : endpoint
  const created = protocol === 'multipart' ? await postVisualMultipart(layout, connection, 'video', payload, references)
    : await post(connection, 'video', { ...payload, ...(['kkrich', 'xai'].includes(protocol) ? {} : await jsonReferences(layout, endpoint, references)) })
  const value = await pollVideo(layout, connection, created)
  const reference = mediaReference(value)
  if (reference === undefined) throw new GenerationApiError('video API response did not contain a media URL or base64 field')
  try { return await writeFile(layout, layout.videosDir, 'video', 'video', reference, connection) }
  catch (error) {
    const id = taskId(created)
    if (id === '') throw error
    throw new GenerationApiError(apiErrorDetail(connection, (error as Error).message)
      + '。视频任务 ID：' + id + '；记录保存在项目 work 目录，请下载原任务结果，勿重复提交。')
  }
}

export async function generateVoice(
  layout: ProjectLayout,
  config: GenerationConfig,
  input: { text: string; voice: string; language?: string; referencePaths?: readonly string[] },
): Promise<GeneratedFile> {
  const endpoint = config.api.voice
  if (endpoint.protocol === 'dashscope') return generateVoiceDashscope(layout, endpoint, input)
  const references = await voiceReferencePayload(layout, input.referencePaths)
  const value = await post(endpoint, 'voice', {
    ...(endpoint.model.trim() === '' ? {} : { model: endpoint.model }),
    input: input.text,
    text: input.text,
    voice: input.voice || 'default',
    language: input.language,
    response_format: 'mp3',
    ...(references.urls.length === 0 ? {} : {
      // Keep the generic adapter useful across providers: the first field is
      // the project UI's canonical name, and the aliases cover APIs that use
      // a singular reference_audio or raw base64 input.
      voice_references: references.urls,
      reference_audio: references.urls.length === 1 ? references.urls[0] : references.urls,
      reference_audio_base64: references.base64.length === 1 ? references.base64[0] : references.base64,
    }),
  }, false)
  const reference = mediaReference(value)
  if (reference === undefined) throw new GenerationApiError('voice API response did not contain audio bytes, URL or base64 field')
  return writeFile(layout, layout.audioDir, 'narration', 'voice', reference)
}

interface CloneCache {
  version: 1
  voices: Record<string, { voice: string; model: string; createdAt: string }>
}

const cloneLocks = new Map<string, Promise<string>>()

function enrollmentEndpoint(config: VoiceApiConfig, speechEndpoint: string): string {
  if ((config.enrollmentEndpoint ?? '').trim() !== '') return config.enrollmentEndpoint.trim()
  const host = new URL(speechEndpoint).hostname
  const root = host === 'dashscope-intl.aliyuncs.com' || host.includes('ap-southeast-1.maas.aliyuncs.com')
    ? 'https://dashscope-intl.aliyuncs.com'
    : host === 'dashscope-us.aliyuncs.com' ? 'https://dashscope-us.aliyuncs.com'
      : host.endsWith('.maas.aliyuncs.com') ? 'https://dashscope.aliyuncs.com' : new URL(speechEndpoint).origin
  return root + '/api/v1/services/audio/tts/customization'
}

async function cloneVoice(layout: ProjectLayout, config: VoiceApiConfig, model: string, dataUrl: string): Promise<string> {
  const endpoint = enrollmentEndpoint(config, dashscopeSpeechEndpoint(config))
  const digest = createHash('sha256').update(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')).digest('hex')
  // Voices are bound to a target model and account. Neither key nor audio is stored.
  const cacheKey = createHash('sha256').update(JSON.stringify([digest, model, endpoint, resolveApiKey(config)])).digest('hex')
  const cachePath = join(layout.assetsDir, 'voice-clones.json')
  const cached = config.cloneCache !== false
  const create = async (): Promise<string> => {
    const stored = cached ? await readJson<CloneCache>(cachePath) : undefined
    const voices = stored?.version === 1 && stored.voices !== null && typeof stored.voices === 'object' ? stored.voices : {}
    const hit = voices[cacheKey]
    if (typeof hit?.voice === 'string' && hit.voice !== '') return hit.voice
    const value = await post({ ...config, endpoint, model: 'qwen-voice-enrollment' }, 'voice enrollment', {
      model: 'qwen-voice-enrollment',
      input: { action: 'create', target_model: model, preferred_name: 'openreel' + digest.slice(0, 12), audio: { data: dataUrl } },
    })
    const output = value !== null && typeof value === 'object' ? (value as { output?: { voice?: unknown } }).output : undefined
    if (typeof output?.voice !== 'string' || output.voice === '') {
      throw new GenerationApiError('声音复刻未返回音色 ID（' + endpoint + '）：' + apiErrorDetail(config, value))
    }
    if (cached) {
      await ensureDir(layout.assetsDir)
      voices[cacheKey] = { voice: output.voice, model, createdAt: new Date().toISOString() }
      await writeJsonAtomic(cachePath, { version: 1, voices } satisfies CloneCache)
    }
    return output.voice
  }
  if (!cached) return create()
  // Serialize cache read/create/write per project, including simultaneous generation requests.
  const previous = cloneLocks.get(cachePath)
  const next = (previous ?? Promise.resolve('')).catch(() => '').then(create)
  cloneLocks.set(cachePath, next)
  try { return await next } finally { if (cloneLocks.get(cachePath) === next) cloneLocks.delete(cachePath) }
}

async function generateVoiceDashscope(
  layout: ProjectLayout,
  config: VoiceApiConfig,
  input: { text: string; voice: string; language?: string; referencePaths?: readonly string[] },
): Promise<GeneratedFile> {
  const endpoint = dashscopeSpeechEndpoint(config)
  if (input.text.trim() === '') throw new GenerationApiError('配音文本不能为空（' + endpoint + '）。')
  const references = await voiceReferencePayload(layout, input.referencePaths)
  if (references.urls.length > 1) throw new GenerationApiError('百炼声音复刻每次使用一段参考音频，请仅保留一段后生成。')
  let model = config.model.trim() || 'qwen3-tts-flash'
  let voice = input.voice.trim()
  if (references.urls[0] !== undefined) {
    model = /^qwen3-tts-vc-(?!realtime)/.test(model) ? model : DASHSCOPE_CLONE_MODEL
    voice = await cloneVoice(layout, config, model, references.urls[0])
  } else if (/^qwen-(?:tts-vc|voice)-/.test(voice)) {
    if (!/^qwen3-tts-vc-(?!realtime)/.test(model)) model = DASHSCOPE_CLONE_MODEL
  } else if (/^qwen3-tts-vc-/.test(model)) {
    throw new GenerationApiError('声音复刻模型需要上传参考音频，或填写已创建的复刻音色 ID（' + endpoint + '）。')
  } else if (voice === '' || voice === 'default') voice = 'Cherry'
  const languages: Record<string, string> = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German', ru: 'Russian', it: 'Italian', pt: 'Portuguese' }
  const instructions = (config.instructions ?? '').trim()
  const value = await post({ ...config, endpoint, model }, 'voice', {
    model,
    input: {
      text: input.text, voice, language_type: languages[input.language ?? ''] ?? 'Auto',
      ...(/^qwen3-tts-instruct-flash/.test(model) && instructions !== '' ? { instructions } : {}),
    },
  })
  const audio = value !== null && typeof value === 'object' ? (value as { output?: { audio?: unknown } }).output?.audio : undefined
  const reference = mediaReference(audio)
  if (reference === undefined) throw new GenerationApiError('百炼未返回 output.audio 音频（' + endpoint + '）：' + apiErrorDetail(config, value))
  return writeFile(layout, layout.audioDir, 'narration', 'voice', reference)
}
