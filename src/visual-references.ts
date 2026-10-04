import { promises as fs } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { resolveInProject, toProjectRelative, type ProjectLayout } from './project.js'

import type { VisualReferences } from './visual-reference-types.js'
export type { VisualReferences } from './visual-reference-types.js'
export const REFERENCE_MAX_BYTES = 20 * 1024 * 1024
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }

export function referenceKind(path: string): 'image' | 'video' | undefined {
  const mime = TYPES[extname(path).toLowerCase()]
  return mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : undefined
}
export function externalReference(value: string): boolean {
  if (/^assetId:\/\/[A-Za-z0-9._-]+$/.test(value)) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
  } catch { return false }
}
export async function checkVisualReferences(layout: ProjectLayout, mode: 'image' | 'video', value: unknown): Promise<VisualReferences> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('参考素材设置格式错误。')
  const input = value as Record<string, unknown>
  if (input.input !== 'text' && input.input !== 'reference') throw new Error('请选择文本生成或参考素材生成。')
  const result: VisualReferences = { input: input.input, images: [], videos: [] }
  for (const [field, kind] of [['images', 'image'], ['videos', 'video']] as const) {
    const entries = input[field]
    if (!Array.isArray(entries) || entries.length > 8 || entries.some(v => typeof v !== 'string' || v.trim() === '')) throw new Error('每种参考素材最多 8 个，地址不能为空。')
    for (const entry of entries as string[]) {
      const value = entry.trim()
      if (externalReference(value)) { result[field].push(value); continue }
      const absolute = resolveInProject(layout, value)
      const root = resolve(layout.assetsDir, 'references', kind)
      const real = await fs.realpath(absolute)
      const realRoot = await fs.realpath(root)
      if (!absolute.startsWith(root + sep) || !real.startsWith(realRoot + sep) || referenceKind(value) !== kind) throw new Error('参考素材必须是项目上传文件或公开 HTTPS 地址 / assetId。')
      const stat = await fs.stat(real)
      if (!stat.isFile() || stat.size === 0 || stat.size > REFERENCE_MAX_BYTES) throw new Error('参考素材为空或超过 20 MB。')
      result[field].push(value)
    }
    result[field] = [...new Set(result[field])]
  }
  if (mode === 'image' && result.videos.length !== 0) throw new Error('图生图只支持参考图片；参考视频请切换视频模式。')
  return result
}
export async function readVisualReference(layout: ProjectLayout, value: string): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  const absolute = resolveInProject(layout, value)
  const bytes = new Uint8Array(await fs.readFile(absolute))
  if (bytes.length === 0 || bytes.length > REFERENCE_MAX_BYTES) throw new Error('参考素材为空或超过 20 MB。')
  return { name: basename(value), mime: TYPES[extname(value).toLowerCase()] ?? 'application/octet-stream', bytes }
}
export async function saveVisualReference(layout: ProjectLayout, kind: 'image' | 'video', original: string, bytes: Buffer): Promise<{ name: string; path: string }> {
  if (referenceKind(original) !== kind) throw new Error('图片支持 PNG、JPG、WEBP；视频支持 MP4、WEBM、MOV。')
  if (bytes.length === 0 || bytes.length > REFERENCE_MAX_BYTES) throw new Error('参考素材须大于 0 且不超过 20 MB。')
  const directory = join(layout.assetsDir, 'references', kind)
  await fs.mkdir(directory, { recursive: true })
  const cleaned = basename(original).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(-160)
  const ext = extname(cleaned)
  const stem = cleaned.slice(0, -ext.length)
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? cleaned : stem + '-' + index + ext
    const absolute = join(directory, name)
    try { await fs.writeFile(absolute, bytes, { flag: 'wx' }); return { name, path: toProjectRelative(layout, absolute) } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
}
