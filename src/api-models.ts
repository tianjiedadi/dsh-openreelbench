/** Model discovery runs on the host, so saved secrets and env keys never reach the browser. */
import type { ApiEndpointConfig, GenerationApiKind, VoiceApiConfig } from './config.js'
import { GenerationApiError, apiHeaders, apiErrorDetail, resolveApiKey, dashscopeSpeechEndpoint } from './generation-api.js'
import { DASHSCOPE_VOICE_MODELS, type ApiModelOption, type ApiModelsResult } from './voice-catalog.js'
import { appendModelsPath, normalizeApiUrl } from './api-url.js'

type QueryConfig = ApiEndpointConfig & Partial<VoiceApiConfig>

function httpUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new GenerationApiError('模型列表地址需要完整的 http:// 或 https:// 地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new GenerationApiError('模型列表地址必须使用 HTTP(S)，鉴权请使用 API Key。')
  }
  url.hash = ''
  return url
}

function modelsEndpoint(kind: GenerationApiKind, config: QueryConfig): string {
  if ((config.modelsUrl ?? '').trim() !== '') {
    const configured = httpUrl(normalizeApiUrl(config.modelsUrl.trim()))
    const path = configured.pathname.replace(/\/+$/, '')
    if (path === '' || /\/v\d+$/i.test(path)) return appendModelsPath(configured.href)
    return configured.href
  }
  if (kind === 'voice' && config.protocol === 'dashscope') {
    const url = httpUrl(dashscopeSpeechEndpoint(config as VoiceApiConfig))
    url.pathname = '/compatible-mode/v1/models'
    url.search = ''
    return url.href
  }
  if (config.endpoint.trim() === '') throw new GenerationApiError('请先填写 API 地址。')
  const url = httpUrl(normalizeApiUrl(config.endpoint.trim()))
  const path = url.pathname.replace(/\/+$/, '')
  if (/\/models$/i.test(path)) url.pathname = path
  else if (/\/(?:audio\/speech|images\/(?:generations|edits)|videos(?:\/generations)?|video\/generations)$/i.test(path)) {
    url.pathname = path.replace(/\/(?:audio\/speech|images\/(?:generations|edits)|videos(?:\/generations)?|video\/generations)$/i, '/models')
  }
  else if (/\/v\d+$/i.test(path)) url.pathname = path + '/models'
  else if (path === '') url.pathname = '/v1/models'
  else throw new GenerationApiError('无法从该生成地址推导模型列表接口，请填写「模型列表地址」。')
  // Query strings can carry routing parameters on private gateways.
  return url.href
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseModels(value: unknown, kind: GenerationApiKind): ApiModelOption[] {
  const root = object(value)
  const output = object(root.output)
  const data = object(root.data)
  const entries = [value, root.data, root.models, output.models, data.models].find(Array.isArray) as unknown[] | undefined
  if (entries === undefined) throw new GenerationApiError('模型接口没有返回 data 或 models 数组，请检查模型列表地址。')
  const models = new Map<string, ApiModelOption>()
  for (const entry of entries) {
    const record = object(entry)
    const raw = typeof entry === 'string' ? entry : record.id ?? record.model ?? record.name
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const id = raw.trim()
    if (id.length > 256) continue
    const capabilities = JSON.stringify([record.capabilities, record.type, record.task, record.tasks, record.endpoints])
    const compatible = kind === 'voice'
      ? (/(?:^|[\/_\s.-])(?:tts|speech|voice|kokoro)(?:$|[\/_\s.-])/i.test(id)
        || /text[-_ ]to[-_ ]speech|speech[-_ ]synthesis|audio\/speech|\btts\b/i.test(capabilities))
        && !/whisper|transcrib|realtime|speech[-_ ]to[-_ ]text/i.test(id)
      : kind === 'image'
        ? /gpt[-_ ]?image|chatgpt[-_ ]?image|image|dall-e|flux|stable[-_ ]?diffusion|sdxl|(?:^|[\/_-])sd3|midjourney|imagen|nano[-_ ]?banana|ideogram|recraft/i.test(id)
          || /text[-_ ]to[-_ ]image|image[-_ ]generation|images\/generations/i.test(capabilities)
        : /sora|veo|kling|seedance|^sd_2\.[05]_|hunyuan[-_ ]?video|(?:^|[\/_-])wan(?:$|[\d\/_-])|video|ltx|minimax.*(?:t2v|i2v)/i.test(id)
          || /text[-_ ]to[-_ ]video|video[-_ ]generation|\bvideos\b/i.test(capabilities)
    models.set(id, { id, label: id, compatible })
  }
  if (models.size === 0) throw new GenerationApiError('模型接口返回了空列表，请检查 Key 和服务权限。')
  return [...models.values()].sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.id.localeCompare(b.id))
}

export async function discoverApiModels(kind: GenerationApiKind, config: QueryConfig): Promise<ApiModelsResult> {
  const url = modelsEndpoint(kind, config)
  const dashscope = kind === 'voice' && config.protocol === 'dashscope'
  const catalog = (reason: string): ApiModelsResult => ({
    models: [...DASHSCOPE_VOICE_MODELS], source: 'catalog', url,
    note: reason + '已加载内置百炼官方语音目录；不是接口实时返回，也不代表账号已开通。',
  })
  // A public catalog needs no secret. Do not attempt an unauthenticated listing.
  if (dashscope && resolveApiKey(config) === '') return catalog('尚未配置 Key。')
  try {
    const response = await fetch(url, {
      headers: { ...apiHeaders(config), accept: 'application/json' },
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    })
    const body = await response.text()
    if (!response.ok) throw new GenerationApiError('模型列表返回 HTTP ' + response.status + '（' + url + '）：' + apiErrorDetail(config, body))
    let value: unknown
    try { value = JSON.parse(body) as unknown } catch { throw new GenerationApiError('模型列表未返回 JSON（' + url + '）。') }
    const models = parseModels(value, kind)
    if (dashscope) {
      // CosyVoice / realtime TTS need other adapters. Chat / omni models are not TTS.
      const supported = models.filter((model) => /^qwen(?:3)?-tts(?:-|$)/i.test(model.id)
        && !/realtime|(?:^|-)vd(?:-|$)/i.test(model.id))
      if (supported.length === 0) return catalog('兼容模型接口未返回本插件支持的千问语音模型。')
      return { models: supported.map((model) => ({ ...model, compatible: true })), source: 'api', url,
        note: '来源：API 返回的千问语音模型；实际可用性仍取决于账号权限和地域。' }
    }
    return { models, source: 'api', url,
      note: models.some((model) => model.compatible)
        ? '已按当前用途筛选模型。筛选依据接口元数据或模型名称，不保证服务已开通；自定义名称可切换显示全部。'
        : '接口未标明当前生成能力，已显示全部模型。请按中转站说明选择。' }
  } catch (error) {
    if (dashscope) return catalog('模型查询失败：' + (error as Error).message + '。')
    throw new GenerationApiError('获取模型失败（' + url + '）：' + (error as Error).message)
  }
}
