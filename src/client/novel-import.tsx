import { useRef, useState } from 'react'
import { api } from './api.ts'
import { NOVEL_DEFAULTS, type NovelOptions, type NovelPreview } from '../novel.ts'
import { tx } from './i18n.ts'

export function NovelImport({ project, disabled = false, onImported }: {
  project?: string; disabled?: boolean; onImported: (id: string) => void | Promise<void>
}): JSX.Element {
  const [source, setSource] = useState<{ name: string; text: string; encoding: string } | null>(null)
  const [title, setTitle] = useState('')
  const [options, setOptions] = useState<NovelOptions>(NOVEL_DEFAULTS)
  const [preview, setPreview] = useState<NovelPreview | null>(null)
  const [chapters, setChapters] = useState<NovelPreview['chapters']>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const locked = disabled || busy
  async function load(file: File): Promise<void> {
    setBusy(true); setError(''); setPreview(null); setSource(null); setChapters([])
    const version = ++revision.current
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error(tx('请选择 TXT 或 MD 小说文件。'))
      if (file.size > 5 * 1024 * 1024) throw new Error(tx('文件超过 5 MB，请按章节拆成多个文件。'))
      const bytes = await file.arrayBuffer()
      let text: string
      let encoding = 'UTF-8'
      if (new Uint8Array(bytes)[0] === 0xff && new Uint8Array(bytes)[1] === 0xfe) {
        text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes); encoding = 'UTF-16'
      } else if (new Uint8Array(bytes)[0] === 0xfe && new Uint8Array(bytes)[1] === 0xff) {
        text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes); encoding = 'UTF-16'
      } else {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); encoding = 'GB18030 / GBK' }
      }
      const next = { name: file.name, text, encoding }
      const nextTitle = file.name.replace(/\.(txt|md)$/i, '')
      const result = await api.previewNovel({ ...next, title: nextTitle, options: NOVEL_DEFAULTS })
      if (revision.current !== version) return
      setSource(next); setTitle(nextTitle); setChapters(result.chapters); setOptions({ ...NOVEL_DEFAULTS, lastChapter: result.chapters.length }); setPreview(result)
    } catch (error) { if (revision.current === version) setError((error as Error).message) }
    finally { setBusy(false) }
  }
  function edit<K extends keyof NovelOptions>(key: K, value: NovelOptions[K]): void {
    revision.current += 1; setOptions(previous => ({ ...previous, [key]: value })); setPreview(null); setError('')
  }
  async function inspect(): Promise<void> {
    if (source === null) return
    setBusy(true); setError(''); setPreview(null)
    try { setPreview(await api.previewNovel({ ...source, title, options })) }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function importFile(): Promise<void> {
    if (source === null || preview?.canImport !== true) return
    setBusy(true); setError('')
    try {
      const result = await api.importNovel({ ...source, options, title, ...(project === undefined ? {} : { project }) })
      await onImported(result.project)
      setSource(null); setPreview(null)
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="orb-card orb-novel-import">
    <div className="orb-card-head"><h3 className="orb-card-title">{tx('导入小说 · 自动分段分镜')}</h3></div>
    <div className="orb-card-body">
      <p className="orb-hint">{tx('支持 TXT、Markdown，自动识别章节，按句子分段、拆镜，保留正文。导入后先确认立项，再审核脚本。')}</p>
      <label className="orb-field"><span className="orb-label">{tx('小说文件')}</span>
        <input type="file" accept=".txt,.md,text/plain,text/markdown" disabled={locked}
          onChange={e => { const file = e.target.files?.[0]; if (file !== undefined) void load(file); e.target.value = '' }} />
      </label>
      {source !== null ? <>
        <p className="orb-hint">{source.name} · {source.encoding}</p>
        <div className="orb-api-settings-grid">
          <label className="orb-field"><span className="orb-label">{tx('项目标题')}</span><input className="orb-input" value={title} disabled={locked} onChange={e => { setTitle(e.target.value); setPreview(null) }} /></label>
          {(['firstChapter', 'lastChapter'] as const).map(key => <label className="orb-field" key={key}>
            <span className="orb-label">{tx(key === 'firstChapter' ? '起始章节序号' : '结束章节序号')}</span>
            <input className="orb-input" type="number" min={1} max={chapters.length} value={options[key]} disabled={locked} onChange={e => edit(key, Number(e.target.value))} />
          </label>)}
          {(['sectionChars', 'shotChars', 'charsPerSecond'] as const).map(key => <label className="orb-field" key={key}>
            <span className="orb-label">{tx(key === 'sectionChars' ? '每段最多字数' : key === 'shotChars' ? '每镜最多字数' : '估算朗读速度（字/秒）')}</span>
            <input className="orb-input" type="number" min={key === 'sectionChars' ? 80 : key === 'shotChars' ? 20 : 2} max={key === 'sectionChars' ? 800 : key === 'shotChars' ? 300 : 10} step={key === 'charsPerSecond' ? 0.1 : 1} value={options[key]} disabled={locked} onChange={e => edit(key, Number(e.target.value))} />
          </label>)}
        </div>
        <button type="button" className="orb-btn" disabled={locked} onClick={() => { void inspect() }}>{tx('更新分段分镜预览')}</button>
        <details><summary>{tx('章节列表')}（{chapters.length}）</summary><div className="orb-novel-scroll">{chapters.map(c => <p key={c.index}>{c.index}. {c.title}（{c.chars} {tx('字')}）</p>)}</div></details>
      </> : null}
      {preview !== null ? <>
        <p>{tx('已识别')} {preview.chapters.length} {tx('章；所选正文')} {preview.selectedChars} {tx('字，')}{preview.sectionCount} {tx('段 / ')}{preview.shotCount} {tx('镜，预计 ')}{Math.ceil(preview.durationSeconds / 60)} {tx('分钟。')}</p>
        {preview.warnings.map(w => <p className="orb-hint" key={w}>{w}</p>)}
        <details><summary>{tx('前五段与分镜预览')}</summary><div className="orb-novel-scroll">{preview.samples.map((s, i) => <div key={i}><h4>{s.label}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{s.text}</p><ol>{s.shots.map((shot, j) => <li key={j}>{shot}</li>)}</ol></div>)}</div></details>
        <button type="button" className="orb-btn orb-btn-accent" disabled={locked || !preview.canImport} onClick={() => { void importFile() }}>{tx(project === undefined ? '导入并创建小说项目' : '导入到当前立项')}</button>
      </> : null}
      {busy ? <p role="status" className="orb-hint">{tx('处理中…')}</p> : null}
      {error !== '' ? <p role="alert" className="orb-note orb-note-error">{error}</p> : null}
    </div>
  </section>
}
