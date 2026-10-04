/** Local novel parsing. Text is data; it is never sent as agent instructions. */
import type { Brief, ScenePlan, Script } from './schema.js'

export interface NovelOptions {
  firstChapter: number
  lastChapter: number
  sectionChars: number
  shotChars: number
  charsPerSecond: number
}
export interface NovelChapter { index: number; title: string; text: string; chars: number }
export interface NovelPreview {
  title: string
  chapters: Array<Omit<NovelChapter, 'text'>>
  selectedChars: number
  sectionCount: number
  shotCount: number
  durationSeconds: number
  canImport: boolean
  warnings: string[]
  samples: Array<{ label: string; text: string; shots: string[] }>
}
export interface NovelImportInfo {
  name: string; draft_path: string; source_path: string
  sections: number; shots: number; duration_seconds: number
  first_chapter: number; last_chapter: number; imported_at: string
  applied_at?: string
}
export const NOVEL_DEFAULTS: NovelOptions = {
  firstChapter: 1, lastChapter: 0, sectionChars: 180, shotChars: 55, charsPerSecond: 4.9,
}

function plainMarkdown(source: string): string {
  return source
    .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*```[^\n]*\n/gm, '').replace(/^\s*```\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '').replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2').replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '')
}

export function parseNovel(source: string, name: string): NovelChapter[] {
  if (!/\.(txt|md)$/i.test(name)) throw new Error('小说仅支持 .txt、.md 文件。')
  if (source.length > 2_000_000) throw new Error('小说超过 200 万字符，请拆成多个文件。')
  const text = /\.md$/i.test(name) ? plainMarkdown(source) : source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (text.includes('\0')) throw new Error('文件不是可读取的 TXT / MD 文本。')
  const chapters: NovelChapter[] = []
  let title = '正文'
  let lines: string[] = []
  const finish = (): void => {
    const content = lines.join('\n').trim()
    if (content !== '') chapters.push({ index: chapters.length + 1, title, text: content, chars: Array.from(content.replace(/\s/g, '')).length })
    lines = []
  }
  for (const line of text.split('\n')) {
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
      ?? /^\s*((?:第[\d零〇一二三四五六七八九十百千万两]+[章回节卷部篇]|Chapter\s+\d+)(?:[^\n]{0,90}))\s*$/i.exec(line)
    if (heading !== null) { finish(); title = heading[1]!.trim(); continue }
    lines.push(line)
  }
  finish()
  if (chapters.length === 0) throw new Error('文件没有可导入的小说正文。')
  return chapters
}

/** Keep sentence endings, dialogue, and paragraph breaks; only long sentences are split. */
function chunks(text: string, maxChars: number): string[] {
  const units = text.match(/[^。！？!?\n]+[。！？!?]*[”’"']*|[。！？!?]+[”’"']*|\n+/g) ?? [text]
  const output: string[] = []
  let current = ''
  const flush = (): void => { if (current.trim() !== '') output.push(current.trim()); current = '' }
  for (const unit of units) {
    const chars = Array.from(unit)
    if (chars.length > maxChars) {
      flush()
      for (let start = 0; start < chars.length; start += maxChars) output.push(chars.slice(start, start + maxChars).join('').trim())
    } else {
      if (Array.from(current + unit).length > maxChars) flush()
      current += unit
    }
  }
  flush()
  return output.filter(Boolean)
}

export function prepareNovel(source: string, name: string, raw: Partial<NovelOptions> = {}, style = 'default', platform: Brief['target_platform'] = 'generic', customTitle = ''): {
  preview: NovelPreview; brief: Brief; script: Script; scenePlan: ScenePlan; options: NovelOptions
} {
  const chapters = parseNovel(source, name)
  const options = { ...NOVEL_DEFAULTS, ...raw }
  if (options.lastChapter === 0) options.lastChapter = chapters.length
  for (const [key, min, max] of [['firstChapter', 1, chapters.length], ['lastChapter', 1, chapters.length], ['sectionChars', 80, 800], ['shotChars', 20, 300]] as const) {
    const value = options[key]
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(key + ' 要在 ' + min + '–' + max + ' 之间。')
  }
  if (options.lastChapter < options.firstChapter) throw new Error('结束章节不能早于起始章节。')
  if (!Number.isFinite(options.charsPerSecond) || options.charsPerSecond < 2 || options.charsPerSecond > 10) throw new Error('朗读速度要在每秒 2–10 字之间。')
  const selected = chapters.slice(options.firstChapter - 1, options.lastChapter)
  const title = customTitle.trim() || name.replace(/\.(txt|md)$/i, '')
  const script: Script = { version: '1.0', title, total_duration_seconds: 0, sections: [], metadata: { source: 'novel-import', source_name: name, ...options } }
  const scenePlan: ScenePlan = { version: '1.0', shots: [] }
  let time = 0
  for (const chapter of selected) {
    for (const text of chunks(chapter.text, options.sectionChars)) {
      const id = 'section-' + String(script.sections.length + 1).padStart(4, '0')
      const seconds = Math.max(1, Math.round(Array.from(text.replace(/\s/g, '')).length / options.charsPerSecond * 10) / 10)
      const end = Math.round((time + seconds) * 10) / 10
      const prompt = '小说场景：' + chapter.title + '。根据以下原文描绘人物、环境和动作，保持角色一致，不添加文字：' + text
      script.sections.push({ id, label: chapter.title + ' · ' + (script.sections.length + 1), text, start_seconds: time, end_seconds: end, visual: { prompt } })
      chunks(text, options.shotChars).forEach((beat, index) => {
        scenePlan.shots.push({ id: id + '-shot-' + index, section_id: id, shot_index: index, weight: Math.max(1, Math.round(Array.from(beat).length / Array.from(text).length * 100)), prompt: '小说场景：' + chapter.title + '。' + beat + '。保持人物外貌和场景连续，无文字、无水印。' })
      })
      time = end
    }
  }
  script.total_duration_seconds = time
  const warnings = ['分镜提示词由原文自动拆分生成，是可编辑草稿；时长按朗读速度估算。']
  if (time > 1800) warnings.push('所选内容预计超过 30 分钟，请缩小章节范围或分多个项目导入；正文不会被自动截断。')
  if (scenePlan.shots.length > 500) warnings.push('分镜超过 500 个，请减少章节或增大每镜字数。')
  const preview: NovelPreview = {
    title, chapters: chapters.map(({ text: _text, ...chapter }) => chapter),
    selectedChars: selected.reduce((sum, c) => sum + c.chars, 0),
    sectionCount: script.sections.length, shotCount: scenePlan.shots.length,
    durationSeconds: time, canImport: time <= 1800 && scenePlan.shots.length <= 500,
    warnings, samples: script.sections.slice(0, 5).map(s => ({ label: s.label!, text: s.text, shots: scenePlan.shots.filter(shot => shot.section_id === s.id).map(s => s.prompt!) })),
  }
  const brief: Brief = {
    version: '1.0', title, hook: script.sections[0]!.text.slice(0, 180),
    key_points: [selected[0]!.title + '起的小说内容', '保留原文朗读，按句子和段落拆分', '根据原文生成连续分镜并人工调整'],
    tone: '小说叙事', style, target_platform: platform, target_duration_seconds: Math.max(5, Math.min(1800, Math.ceil(time))),
    metadata: { source: 'novel-import', source_name: name },
  }
  return { preview, brief, script, scenePlan, options }
}
