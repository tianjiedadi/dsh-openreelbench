/** Project-local API input options; final rendering continues to use the project profile. */
import { type FormEvent, useEffect, useState } from 'react'
import {
  GENERATION_SIZE_BOUNDS, GENERATION_SIZE_PRESETS,
  type GenerationSize, generationSizeError, resolveGenerationSize, videoSecondsError,
} from '../generation-size.ts'
import { api, type ProjectMarker } from './api.ts'
import { tx } from './i18n.ts'

interface VisualSizeSettingsProps {
  project: ProjectMarker
  mode: 'image' | 'video'
  outputFrame: GenerationSize
  disabled: boolean
  onSaved: () => Promise<void>
  onBusyChange: (busy: boolean) => void
  onReadyChange: (ready: boolean) => void
}

interface Draft {
  custom: boolean
  width: string
  height: string
  fixedSeconds: boolean
  seconds: string
}

export function VisualSizeSettings({ project, mode, outputFrame, disabled, onSaved, onBusyChange, onReadyChange }: VisualSizeSettingsProps): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const size = resolveGenerationSize(project.api_visual_sizes?.[mode], outputFrame)
  const saved: Draft = {
    custom: project.api_visual_sizes?.[mode] !== undefined,
    width: String(size.width), height: String(size.height),
    fixedSeconds: project.api_video_seconds !== undefined,
    seconds: String(project.api_video_seconds ?? 4),
  }
  const current = draft ?? saved
  const dirty = draft !== null
  const readOnly = disabled || saving
  const sizeError = current.custom ? generationSizeError({ width: Number(current.width), height: Number(current.height) }) : undefined
  const secondsError = mode === 'video' && current.fixedSeconds ? videoSecondsError(Number(current.seconds)) : undefined
  const error = sizeError ?? secondsError
  const ratioDiffers = current.custom && sizeError === undefined
    && Math.abs((Number(current.width) / Number(current.height)) / (outputFrame.width / outputFrame.height) - 1) > 0.01
  const preset = current.custom ? current.width + 'x' + current.height : 'follow'
  const presetKnown = GENERATION_SIZE_PRESETS.some((entry) => entry.width + 'x' + entry.height === preset)

  useEffect(() => { onReadyChange(!dirty && !saving && error === undefined) }, [dirty, saving, error, onReadyChange])

  function change(patch: Partial<Draft>): void {
    setDraft({ ...current, ...patch })
    setResult(null)
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (readOnly || !dirty) return
    if (error !== undefined) { setResult({ kind: 'error', text: tx(error) }); return }
    setSaving(true)
    onBusyChange(true)
    setResult(null)
    try {
      await api.updateProject({
        project: project.id,
        api_visual_size: { mode, size: current.custom ? { width: Number(current.width), height: Number(current.height) } : null },
        ...(mode === 'video' ? { api_video_seconds: current.fixedSeconds ? Number(current.seconds) : null } : {}),
      })
      // Keep the draft until the project refresh succeeds, so the request size
      // shown in the parent cannot silently lag behind an accepted save.
      await onSaved()
      setDraft(null)
      setResult({ kind: 'ok', text: tx('生成参数已保存，下一次生成会使用这些尺寸和时长。') })
    } catch (reason) {
      setResult({ kind: 'error', text: tx('保存或刷新失败，请保留填写内容并重试：') + (reason as Error).message })
    } finally {
      setSaving(false)
      onBusyChange(false)
    }
  }

  return (
    <form id="orb-api-visual-settings" className="orb-visual-size-settings" onSubmit={(event) => { void save(event) }}>
      <div className="orb-visual-size-heading">
        <b>{mode === 'video' ? tx('视频生成尺寸') : tx('图片生成尺寸')}</b>
        <span className="orb-hint">{tx('成片尺寸：')}{outputFrame.width}×{outputFrame.height}</span>
        <span className={'orb-pill ' + (dirty ? 'orb-pill-wait' : 'orb-pill-ok')}>{dirty ? tx('待保存') : tx('已保存')}</span>
      </div>
      <div className="orb-api-settings-grid">
        <label className="orb-field">
          <span className="orb-label">{tx('尺寸选择')}</span>
          <select className="orb-select" value={current.custom && !presetKnown ? 'custom' : preset} disabled={readOnly}
            onChange={(event) => {
              const value = event.target.value
              if (value === 'follow') change({ custom: false })
              else if (value === 'custom') change({ custom: true })
              else {
                const [width, height] = value.split('x')
                change({ custom: true, width: width!, height: height! })
              }
            }}>
            <option value="follow">{tx('跟随成片尺寸')} · {outputFrame.width}×{outputFrame.height}</option>
            <option value="custom">{tx('自定义宽高')}</option>
            {GENERATION_SIZE_PRESETS.map((entry) => <option key={entry.width + 'x' + entry.height} value={entry.width + 'x' + entry.height}>
              {entry.width}×{entry.height}
            </option>)}
          </select>
        </label>
        <div className="orb-visual-size-dimensions">
          <label className="orb-field"><span className="orb-label">{tx('宽度（像素）')}</span>
            <input className="orb-input" type="number" inputMode="numeric" min={GENERATION_SIZE_BOUNDS.min}
              max={GENERATION_SIZE_BOUNDS.max} step={1} required disabled={readOnly || !current.custom}
              value={current.custom ? current.width : outputFrame.width} onChange={(event) => change({ width: event.target.value })} />
          </label>
          <span className="orb-hint" aria-hidden="true">×</span>
          <label className="orb-field"><span className="orb-label">{tx('高度（像素）')}</span>
            <input className="orb-input" type="number" inputMode="numeric" min={GENERATION_SIZE_BOUNDS.min}
              max={GENERATION_SIZE_BOUNDS.max} step={1} required disabled={readOnly || !current.custom}
              value={current.custom ? current.height : outputFrame.height} onChange={(event) => change({ height: event.target.value })} />
          </label>
          <button className="orb-btn orb-btn-small" type="button" disabled={readOnly || !current.custom}
            onClick={() => change({ width: current.height, height: current.width })}>{tx('交换宽高')}</button>
        </div>
        {mode === 'video' ? <div className="orb-field">
          <label className="orb-check"><input type="checkbox" checked={current.fixedSeconds} disabled={readOnly}
            onChange={(event) => change({ fixedSeconds: event.target.checked })} />
            <span className="orb-label">{tx('固定视频生成时长（秒）')}</span></label>
          <input className="orb-input" type="number" min={1} max={300} step="any" required
            value={current.seconds} disabled={readOnly || !current.fixedSeconds}
            onChange={(event) => change({ seconds: event.target.value })} />
          <span className="orb-hint">{tx('如模型只支持 4、8、12 秒，可填写固定值；未勾选时按各镜计划时长请求。')}</span>
        </div> : null}
      </div>
      <p className="orb-hint">{tx('按所选模型支持的尺寸填写。图片和视频分别保存，尺寸不会被自动取整为其他数值。')}</p>
      {ratioDiffers ? <p className="orb-note orb-note-warn">{tx('生成比例与成片比例不同，合成时会按风格裁切或留边。')}</p> : null}
      {error !== undefined ? <p className="orb-note orb-note-error" role="status">{tx(error)}</p> : null}
      <div className="orb-actions">
        {result !== null ? <span role="status" className={'orb-note ' + (result.kind === 'ok' ? 'orb-note-ok' : 'orb-note-error')}>{result.text}</span> : null}
        <span className="orb-spacer" />
        <button className="orb-btn orb-btn-small" type="button" disabled={readOnly}
          onClick={() => change({ custom: false, fixedSeconds: false })}>{tx('恢复默认')}</button>
        <button className="orb-btn orb-btn-small" type="button" disabled={readOnly || !dirty}
          onClick={() => { setDraft(null); setResult(null) }}>{tx('撤销')}</button>
        <button className="orb-btn orb-btn-small orb-btn-accent" type="submit" disabled={readOnly || !dirty || error !== undefined}>
          {saving ? tx('保存中…') : tx('保存生成参数')}
        </button>
      </div>
    </form>
  )
}
