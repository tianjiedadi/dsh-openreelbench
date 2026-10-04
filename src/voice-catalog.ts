/** Models supported by our synchronous DashScope Qwen adapter, not account entitlements.
 * Source: https://help.aliyun.com/zh/model-studio/qwen-tts-api
 *         https://help.aliyun.com/zh/model-studio/qwen-tts-voice-cloning
 */
export const DASHSCOPE_CLONE_MODEL = 'qwen3-tts-vc-2026-01-22'

export interface ApiModelOption {
  id: string
  label: string
  compatible: boolean
}

export interface ApiModelsResult {
  models: ApiModelOption[]
  source: 'api' | 'catalog'
  url: string
  note: string
}

export const DASHSCOPE_VOICE_MODELS: readonly ApiModelOption[] = [
  { id: 'qwen3-tts-flash', label: 'qwen3-tts-flash · 内置音色', compatible: true },
  { id: 'qwen3-tts-instruct-flash', label: 'qwen3-tts-instruct-flash · 指令控声', compatible: true },
  { id: DASHSCOPE_CLONE_MODEL, label: DASHSCOPE_CLONE_MODEL + ' · 声音复刻', compatible: true },
  { id: 'qwen3-tts-flash-2025-11-27', label: 'qwen3-tts-flash-2025-11-27 · 固定版本', compatible: true },
  { id: 'qwen3-tts-flash-2025-09-18', label: 'qwen3-tts-flash-2025-09-18 · 固定版本', compatible: true },
  { id: 'qwen3-tts-instruct-flash-2026-01-26', label: 'qwen3-tts-instruct-flash-2026-01-26 · 固定版本', compatible: true },
]

export const DASHSCOPE_SYSTEM_VOICES = ['Cherry', 'Ethan', 'Serena'] as const
