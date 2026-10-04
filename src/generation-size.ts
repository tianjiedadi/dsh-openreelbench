/** API generation dimensions are independent of the final render profile. */
export interface GenerationSize {
  width: number
  height: number
}

export const GENERATION_SIZE_BOUNDS = { min: 1, max: 16384 } as const

/** Convenience choices, not claims about any provider's supported resolutions. */
export const GENERATION_SIZE_PRESETS: readonly GenerationSize[] = [
  { width: 512, height: 512 },
  { width: 768, height: 768 },
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
  { width: 1792, height: 1024 },
  { width: 1024, height: 1792 },
  { width: 1280, height: 720 },
  { width: 720, height: 1280 },
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 },
  { width: 2048, height: 1152 },
  { width: 1152, height: 2048 },
]

export function generationSizeError(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '生成尺寸需要包含宽度和高度。'
  const size = value as Record<string, unknown>
  for (const field of ['width', 'height'] as const) {
    const pixels = size[field]
    if (typeof pixels !== 'number' || !Number.isInteger(pixels)
      || pixels < GENERATION_SIZE_BOUNDS.min || pixels > GENERATION_SIZE_BOUNDS.max) {
      return '宽度和高度必须是 1–16384 之间的整数像素，请按模型支持的尺寸填写。'
    }
  }
  return undefined
}

export function resolveGenerationSize(value: GenerationSize | undefined, fallback: GenerationSize): GenerationSize {
  return value !== undefined && generationSizeError(value) === undefined ? value : { width: fallback.width, height: fallback.height }
}

export function videoSecondsError(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 300
    ? undefined : '视频生成时长必须是 1–300 秒，请按模型支持的时长填写。'
}
