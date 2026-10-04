/** API configuration next to the generation buttons, using DSH's live settings. */
import { type FormEvent, useEffect, useState } from 'react'

import type { VoiceApiConfig, VisualApiConfig, Config } from '../config.ts'
import { type SettingsScope, type SettingsPathOp, useScope } from './scope.ts'
import { IconSliders } from './icons.tsx'
import { tx } from './i18n.ts'
import { ModelPicker } from './model-picker.tsx'
import { normalizeApiUrl } from '../api-url.ts'

export type ApiKind = 'voice' | 'image' | 'video'
type EditableApi = VoiceApiConfig & VisualApiConfig

interface ApiSettingsProps {
  kind: ApiKind
  scope: SettingsScope<Config>
  disabled?: boolean
  onSaved: () => Promise<void>
  onReadyChange: (ready: boolean) => void
}

export function ApiSettings({ kind, scope, disabled = false, onSaved, onReadyChange }: ApiSettingsProps): JSX.Element {
  const snapshot = useScope(scope)
  const saved = snapshot.value?.generation?.api?.[kind] as Partial<EditableApi> | undefined
  const [draft, setDraft] = useState<Partial<EditableApi>>({})
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const title = tx(kind === 'voice' ? '语音 API 设置' : kind === 'video' ? '生视频 API 设置' : '生图 API 设置')
  const dirty = Object.keys(draft).length > 0
  const dashscope = kind === 'voice' && (draft.protocol ?? saved?.protocol) === 'dashscope'
  const configured = (kind === 'voice' && saved?.protocol === 'dashscope' || (saved?.endpoint?.trim() ?? '') !== '')
    && (kind === 'voice' || (saved?.model?.trim() ?? '') !== '')
  const ready = snapshot.status === 'ready' && configured && !dirty && !saving
  const readOnly = snapshot.status !== 'ready' || !snapshot.writable || disabled || saving

  useEffect(() => { onReadyChange(ready) }, [ready, onReadyChange])

  function change<K extends keyof EditableApi>(field: K, value: EditableApi[K]): void {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setResult(null)
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (readOnly || !dirty) return
    const endpoint = (draft.endpoint ?? saved?.endpoint ?? '').trim()
    try {
      if (!(dashscope && endpoint === '') && !['http:', 'https:'].includes(new URL(endpoint).protocol)) throw new Error()
    } catch {
      setResult({ kind: 'error', text: tx('API 地址需要完整的 http:// 或 https:// 地址。') })
      return
    }
    if (kind !== 'voice' && (draft.model ?? saved?.model ?? '').trim() === '') {
      setResult({ kind: 'error', text: tx('请填写模型名称。') })
      return
    }
    setSaving(true)
    setResult(null)
    try {
      const ops: SettingsPathOp[] = Object.entries(draft).map(([field, value]) => ({
        op: 'set', path: ['generation', 'api', kind, field], value: typeof value === 'string'
          ? ['endpoint', 'modelsUrl', 'referenceEndpoint', 'pollUrl'].includes(field) ? normalizeApiUrl(value) : value.trim() : value,
      }))
      // An empty Key means keep the saved secret.
      const changes = ops.filter((op) => op.path[3] !== 'apiKey' || ('value' in op && op.value !== ''))
      const accepted = changes.length === 0 || await scope.mutate(changes, snapshot.revision)
      if (!accepted) throw new Error(tx('DSH 未接受保存，配置可能已发生变化。请保留填写内容，刷新后再保存。'))
      setDraft({})
      setResult({ kind: 'ok', text: tx('API 设置已保存。现在可以生成，完成后确认进入下一步。') })
      // A project refresh failure should not describe an accepted settings save as failed.
      await onSaved().catch(() => {})
    } catch (error) {
      setResult({ kind: 'error', text: tx('保存失败：') + (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const read = (field: Exclude<keyof EditableApi, 'cloneCache' | 'generateAudio'>): string =>
    draft[field] ?? (field === 'apiKey' ? '' : saved?.[field] ?? '')
  const connection = {
    endpoint: read('endpoint'), modelsUrl: read('modelsUrl'), apiKey: read('apiKey'), apiKeyEnv: read('apiKeyEnv'),
    protocol: kind === 'voice' ? draft.protocol ?? saved?.protocol ?? 'openai' : 'openai' as const,
  }
  const connectionDirty = ['endpoint', 'modelsUrl', 'apiKey', 'apiKeyEnv', 'protocol'].some((field) => field in draft)
  const xai = kind === 'video' && (read('visualProtocol') === 'xai'
    || ((!read('visualProtocol') || read('visualProtocol') === 'auto') && /grok-imagine-video/i.test(read('model'))))

  return (
    <section className="orb-card orb-api-settings" id={'orb-api-settings-' + kind}>
      <div className="orb-card-head">
        <IconSliders className="orb-section-icon" />
        <h3 className="orb-card-title">{title}</h3>
        <span className={'orb-pill ' + (ready ? 'orb-pill-ok' : 'orb-pill-wait')}>
          {snapshot.status === 'loading' ? tx('读取中…') : dirty ? tx('待保存') : ready ? tx('已配置') : tx('待配置')}
        </span>
      </div>
      <form className="orb-card-body" onSubmit={(event) => { void save(event) }}>
        <p className="orb-hint">{tx('直接在这里填写并保存。与设置页共用，保存后立即生效。')}</p>
        <div className="orb-api-settings-grid">
          {kind === 'voice' ? <label className="orb-field">
            <span className="orb-label">{tx('语音接口协议')}</span>
            <select className="orb-select" value={connection.protocol} disabled={readOnly}
              onChange={(event) => change('protocol', event.target.value as VoiceApiConfig['protocol'])}>
              <option value="openai">{tx('通用 / 中转站（OpenAI 兼容）')}</option>
              <option value="dashscope">{tx('阿里云百炼原生（可选）')}</option>
            </select>
          </label> : null}
          <label className="orb-field">
            <span className="orb-label">{tx('API 地址')}</span>
            <input className="orb-input" type="url" required={!dashscope} value={read('endpoint')} disabled={readOnly}
              placeholder={dashscope ? 'https://dashscope.aliyuncs.com' : kind === 'voice' ? 'https://api.example.com/v1/audio/speech'
                : kind === 'video' ? 'https://api.example.com/v1/videos' : 'https://api.example.com/v1/images/generations'}
              autoComplete="off" spellCheck={false} onChange={(event) => change('endpoint', event.target.value)} />
            <span className="orb-hint">{dashscope
              ? tx('留空使用百炼北京地域；也可填专享域名或完整原生接口。')
              : tx('填写自己的中转站完整生成接口；也支持根地址或 /v1，自动补全常见路径。')}</span>
          </label>
          <div className="orb-field">
            <span className="orb-label">{tx('模型名称')}</span>
            <ModelPicker kind={kind} connection={connection} value={read('model')} disabled={readOnly}
              enabled={snapshot.status === 'ready'} autoLoad={!connectionDirty}
              onChange={(value) => change('model', value)} />
            {kind === 'voice' ? <span className="orb-hint">{dashscope
              ? tx('默认 qwen3-tts-flash；上传参考音频时自动使用声音复刻模型。')
              : tx('语音接口允许默认模型时可留空。')}</span> : null}
          </div>
          <label className="orb-field">
            <span className="orb-label">API Key</span>
            <input className="orb-input" type="password" value={read('apiKey')} disabled={readOnly}
              placeholder={tx('输入 Key；留空保留已保存的 Key')}
              autoComplete="new-password" spellCheck={false} onChange={(event) => change('apiKey', event.target.value)} />
            <span className="orb-hint">{tx('本地免鉴权接口可留空，已保存的 Key 不会回显。')}</span>
          </label>
          <label className="orb-field">
            <span className="orb-label">{tx('Key 环境变量（可选）')}</span>
            <input className="orb-input" type="text" value={read('apiKeyEnv')} disabled={readOnly}
              placeholder={kind === 'voice' ? 'TTS_API_KEY' : kind === 'video' ? 'VIDEO_API_KEY' : 'IMAGE_API_KEY'}
              autoComplete="off" spellCheck={false} onChange={(event) => change('apiKeyEnv', event.target.value)} />
            <span className="orb-hint">{tx('未直接填写 Key 时，从 DSH 进程的此环境变量读取。')}</span>
          </label>
          <label className="orb-field">
            <span className="orb-label">{tx('模型列表地址（可选）')}</span>
            <input className="orb-input" type="url" value={read('modelsUrl')} disabled={readOnly}
              placeholder="https://api.example.com/v1/models" autoComplete="off" spellCheck={false}
              onChange={(event) => change('modelsUrl', event.target.value)} />
            <span className="orb-hint">{tx('留空自动推导 /models。中转站有自定义查询路径时填写其完整 GET 地址。')}</span>
          </label>
          {dashscope ? <>
            <label className="orb-field">
              <span className="orb-label">{tx('指令控声（可选）')}</span>
              <input className="orb-input" value={read('instructions')} disabled={readOnly}
                placeholder={tx('例如：语速偏慢，沉稳温柔')} onChange={(event) => change('instructions', event.target.value)} />
              <span className="orb-hint">{tx('仅 qwen3-tts-instruct-flash 系列生效。')}</span>
            </label>
            <label className="orb-field">
              <span className="orb-label">{tx('声音复刻地址（可选）')}</span>
              <input className="orb-input" type="url" value={read('enrollmentEndpoint')} disabled={readOnly}
                placeholder="https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
                onChange={(event) => change('enrollmentEndpoint', event.target.value)} />
              <span className="orb-hint">{tx('留空使用对应地域公共接口；代理百炼原生协议的中转站可填写自己的复刻地址。')}</span>
            </label>
            <label className="orb-check"><input type="checkbox" checked={draft.cloneCache ?? saved?.cloneCache ?? true}
              disabled={readOnly} onChange={(event) => change('cloneCache', event.target.checked)} />
              <span className="orb-label">{tx('缓存复刻音色，重复使用同一音频时复用')}</span></label>
          </> : null}
          {kind !== 'voice' ? <>
            <label className="orb-field">
              <span className="orb-label">{tx('图片 / 视频接口协议')}</span>
              <select className="orb-select" value={read('visualProtocol') || 'auto'} disabled={readOnly} onChange={e => change('visualProtocol', e.target.value as VisualApiConfig['visualProtocol'])}>
                <option value="auto">{tx('自动（识别 Seedance / Grok Imagine）')}</option>
                <option value="json">{tx('通用 JSON（地址 / Base64 参考）')}</option>
                <option value="multipart">{tx('文件上传（multipart）')}</option>
                {kind === 'video' ? <option value="kkrich">KKRICH Seedance</option> : null}
                {kind === 'video' ? <option value="xai">xAI / Grok Imagine</option> : null}
              </select>
              <span className="orb-hint">{tx('自动模式下，图生图上传到 images/edits；视频按所选模型匹配协议。')}</span>
            </label>
            {xai ? <label className="orb-field">
              <span className="orb-label">{tx('Grok 视频分辨率')}</span>
              <select className="orb-select" value={read('resolution') || '720p'} disabled={readOnly}
                onChange={event => change('resolution', event.target.value as VisualApiConfig['resolution'])}>
                <option value="480p">480p</option><option value="720p">720p</option>
              </select>
              <span className="orb-hint">{tx('时长需为 1–15 秒整数；最多一张本地或 HTTPS 参考图，不支持参考视频。生成比例可能跟随参考图，竖版请使用竖版参考图。其他自定义比例映射到横版或竖版，最终合成仍使用项目宽高。')}</span>
            </label> : null}
            <label className="orb-field">
              <span className="orb-label">{tx('高级：参考生成地址（可选）')}</span>
              <input className="orb-input" type="url" value={read('referenceEndpoint')} disabled={readOnly} onChange={e => change('referenceEndpoint', e.target.value)}
                placeholder={kind === 'image' ? 'https://api.example.com/v1/images/edits' : 'https://api.example.com/v1/videos'} />
              <span className="orb-hint">{tx(xai
                ? '通常留空，与文生视频使用同一接口。参考模式可选择一张本地图片或公开 HTTPS 图片。'
                : '普通使用留空即可。请在下方「API 参考素材」直接上传本地图片或本地参考视频；这里仅用于接口有独立参考端点时覆盖自动路径。')}</span>
            </label>
            {!xai ? <><label className="orb-field"><span className="orb-label">{tx('参考图片字段（可选）')}</span>
              <input className="orb-input" value={read('imageField')} disabled={readOnly} placeholder={kind === 'image' ? 'image / reference_image' : 'input_reference / reference_image'} onChange={e => change('imageField', e.target.value)} />
            </label>
            {kind === 'video' ? <label className="orb-field"><span className="orb-label">{tx('参考视频字段（可选）')}</span>
              <input className="orb-input" value={read('videoField')} disabled={readOnly} placeholder="reference_video" onChange={e => change('videoField', e.target.value)} />
            </label> : null}
            <label className="orb-field"><span className="orb-label">{tx('通用 JSON 本地素材编码')}</span>
              <select className="orb-select" value={read('referenceEncoding') || 'data-url'} disabled={readOnly} onChange={e => change('referenceEncoding', e.target.value as VisualApiConfig['referenceEncoding'])}>
                <option value="data-url">Data URL</option><option value="base64">Base64</option>
              </select>
            </label>
            {kind === 'video' ? <label className="orb-check"><input type="checkbox" checked={draft.generateAudio ?? saved?.generateAudio ?? false} disabled={readOnly} onChange={e => change('generateAudio', e.target.checked)} />
              <span className="orb-label">{tx('Seedance 生成视频音轨')}</span>
            </label> : null}
            </> : null}
          </> : null}
          {kind === 'video' ? (
            <label className="orb-field">
              <span className="orb-label">{tx('视频任务查询地址（可选）')}</span>
              <input className="orb-input" type="text" value={read('pollUrl')} disabled={readOnly}
                placeholder="https://api.example.com/v1/videos/{id}"
                autoComplete="off" spellCheck={false} onChange={(event) => change('pollUrl', event.target.value)} />
              <span className="orb-hint">{tx(xai
                ? '通常留空，自动查询生成地址下的 /videos/{id}。自定义时填写中转站的任务 API 地址；网页地址无法查询视频任务。'
                : '可填完整地址（包含 {id}）；只填 /v1、/videos 或 /video/generations 时会自动补上任务路径。查询地址允许与生成地址使用不同域名，但必须是同一中转站的任务查询接口。')}</span>
            </label>
          ) : null}
        </div>
        {snapshot.status === 'unavailable' ? <p className="orb-note orb-note-error">{tx('DSH 尚未提供本插件的配置。请重启 DSH 后重新打开本页。')}</p>
          : snapshot.status === 'ready' && !snapshot.writable ? <p className="orb-note orb-note-error">{tx('当前连接不接受写入，改动无法保存。')}</p>
            : !configured ? <p className="orb-note">{tx('先填写 API 地址和模型，保存后再点击生成。')}</p> : null}
        <div className="orb-actions">
          {result !== null ? <span role="status" className={'orb-note ' + (result.kind === 'ok' ? 'orb-note-ok' : 'orb-note-error')}>{result.text}</span> : null}
          <span className="orb-spacer" />
          <button className="orb-btn" type="button" disabled={!dirty || saving}
            onClick={() => { setDraft({}); setResult(null) }}>{tx('撤销')}</button>
          <button className="orb-btn orb-btn-accent" type="submit" disabled={!dirty || readOnly}>
            {saving ? tx('保存中…') : tx('保存 API 设置')}
          </button>
        </div>
      </form>
    </section>
  )
}
