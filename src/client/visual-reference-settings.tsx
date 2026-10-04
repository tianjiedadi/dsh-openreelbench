import { useEffect, useState } from 'react'
import type { VisualReferences } from '../visual-reference-types.ts'
import { api, type ProjectMarker } from './api.ts'
import { AssetPicker, type AssetFile } from './asset-picker.tsx'
import { tx } from './i18n.ts'

const EMPTY: VisualReferences = { input: 'text', images: [], videos: [] }

export function VisualReferenceSettings({ project, mode, disabled, onSaved, onReadyChange, onBusyChange }: {
  project: ProjectMarker; mode: 'image' | 'video'; disabled: boolean
  onSaved: () => Promise<void>; onReadyChange: (ready: boolean) => void
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const saved = project.api_visual_references?.[mode] ?? EMPTY
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const [urlKind, setUrlKind] = useState<'image' | 'video'>('image')
  const [picker, setPicker] = useState<'image' | 'video' | null>(null)
  const ready = !busy && url.trim() === '' && (saved.input === 'text' || saved.images.length + saved.videos.length > 0)
  useEffect(() => { onReadyChange(ready) }, [ready, onReadyChange])
  const locked = disabled || busy
  async function save(next: VisualReferences): Promise<void> {
    setBusy(true); onBusyChange(true); setError('')
    try { await api.updateProject({ project: project.id, api_visual_references: { mode, value: next } }); await onSaved(); setUrl('') }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false); onBusyChange(false) }
  }
  async function attach(file: AssetFile): Promise<void> {
    const field = file.kind === 'video' ? 'videos' : 'images'
    const path = file.path
    if (path === undefined) return
    if (saved[field].includes(path)) { setError(tx('该素材已经选中。')); return }
    await save({ ...saved, input: 'reference', [field]: [...saved[field], path] })
  }
  async function uploadLocal(file: File, kind: 'image' | 'video'): Promise<void> {
    setBusy(true); onBusyChange(true); setError('')
    try {
      const uploaded = await api.uploadVisualReference(project.id, kind, file)
      await save({ ...saved, input: 'reference', [kind === 'video' ? 'videos' : 'images']: [
        ...saved[kind === 'video' ? 'videos' : 'images'], uploaded.path,
      ] })
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false); onBusyChange(false) }
  }
  function addUrl(): void {
    const value = url.trim()
    let valid = /^assetId:\/\/[A-Za-z0-9._-]+$/.test(value)
    try { const parsed = new URL(value); valid ||= parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === '' } catch { /* show field error */ }
    if (!valid) { setError(tx('请填写公开 HTTPS 地址或平台签发的 assetId://。')); return }
    const field = urlKind === 'video' ? 'videos' : 'images'
    if (saved[field].includes(value)) { setError(tx('该地址已添加。')); return }
    void save({ ...saved, input: 'reference', [field]: [...saved[field], value] })
  }
  const thumbnail = (value: string): string => '/openreel/media?' + new URLSearchParams({ project: project.id, path: value }).toString()
  return <section className="orb-visual-size-settings" id="orb-api-reference-settings">
    <div className="orb-visual-size-heading"><strong>{tx('API 参考素材')}</strong>
      <select className="orb-select" value={saved.input} disabled={locked} onChange={e => { void save({ ...saved, input: e.target.value === 'reference' ? 'reference' : 'text' }) }}>
        <option value="text">{tx(mode === 'image' ? '文生图' : '文生视频')}</option>
        <option value="reference">{tx(mode === 'image' ? '图生图' : '参考图 / 参考视频生成')}</option>
      </select>
    </div>
    {saved.input === 'reference' ? <>
      <p className="orb-hint">{tx('素材随项目保存，每个文件最多 20 MB。通用中转站会把本地文件按接口协议发送；是否支持参考素材、数量和格式取决于所选模型。')}</p>
      <div className="orb-actions">
        <label className="orb-btn orb-file-button">
          {tx(mode === 'image' ? '上传本地参考图片' : '上传本地参考视频')}
          <input type="file" hidden disabled={locked} accept={mode === 'image' ? 'image/png,image/jpeg,image/webp' : 'video/mp4,video/webm,video/quicktime'}
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file !== undefined) void uploadLocal(file, mode === 'image' ? 'image' : 'video') }} />
        </label>
        <button type="button" className="orb-btn" disabled={locked} onClick={() => setPicker(mode === 'video' ? 'video' : 'image')}>{tx('选择已上传素材')}</button>
        {mode === 'video' ? <>
          <label className="orb-btn orb-file-button">
            {tx('上传本地参考图片')}
            <input type="file" hidden disabled={locked} accept="image/png,image/jpeg,image/webp"
              onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file !== undefined) void uploadLocal(file, 'image') }} />
          </label>
          <button type="button" className="orb-btn" disabled={locked} onClick={() => setPicker('image')}>{tx('选择参考图片')}</button>
        </> : null}
      </div>
      <details className="orb-reference-advanced">
        <summary>{tx('高级：公开地址 / assetId（KKRICH 等接口使用）')}</summary>
        <div className="orb-reference-url">
        {mode === 'video' ? <select className="orb-select" value={urlKind} disabled={locked} onChange={e => setUrlKind(e.target.value === 'video' ? 'video' : 'image')}><option value="image">{tx('参考图片地址')}</option><option value="video">{tx('参考视频地址')}</option></select> : null}
        <input className="orb-input" value={url} disabled={locked} placeholder="https://… / assetId://…" onChange={e => { setUrl(e.target.value); setError('') }} />
        <button type="button" className="orb-btn" disabled={locked || url.trim() === ''} onClick={addUrl}>{tx('添加地址')}</button>
        {url !== '' ? <button type="button" className="orb-btn" disabled={locked} onClick={() => setUrl('')}>{tx('清空输入')}</button> : null}
        </div>
      </details>
      <div className="orb-api-reference-list">{(['images', 'videos'] as const).flatMap(field => saved[field].map(value => {
        const local = value.startsWith('assets/references/')
        return <div className="orb-api-reference-item" key={field + value}>
          {local ? field === 'images' ? <img src={thumbnail(value)} alt={value.split('/').pop()} /> : <video src={thumbnail(value)} controls preload="metadata" /> : <span className="orb-hint">{tx(field === 'images' ? '参考图地址' : '参考视频地址')}</span>}
          <span className="orb-reference-name" title={value}>{value.split('/').pop() || value}</span>
          <button type="button" className="orb-btn" disabled={locked} onClick={() => { void save({ ...saved, [field]: saved[field].filter(v => v !== value) }) }}>{tx('移除')}</button>
        </div>
      }))}</div>
      {saved.images.length + saved.videos.length === 0 ? <p className="orb-note">{tx('请添加参考素材后再生成。')}</p> : null}
    </> : <p className="orb-hint">{tx('文本模式仅发送提示词；切换参考模式可使用已选素材。')}</p>}
    {error !== '' ? <p role="alert" className="orb-note orb-note-error">{error}</p> : null}
    {busy ? <p role="status" className="orb-hint">{tx('保存参考素材中…')}</p> : null}
    {picker !== null ? <AssetPicker kinds={[picker]} onClose={() => setPicker(null)} onPick={file => { setPicker(null); void attach(file) }}
      listFiles={async () => (await api.visualReferences(project.id, picker)).files.map(file => ({ ...file, kind: picker, source: 'imported' }))}
      uploadFile={async file => ({ ...await api.uploadVisualReference(project.id, picker, file), kind: picker, source: 'imported' })} /> : null}
  </section>
}
