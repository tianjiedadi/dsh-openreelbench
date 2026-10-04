/** Shared by the three generation pages and the global settings form. */
import { useEffect, useRef, useState } from 'react'
import type { GenerationApiKind } from '../config.ts'
import type { ApiModelsResult } from '../voice-catalog.ts'
import { api, type ModelConnection } from './api.ts'
import { tx } from './i18n.ts'

interface ModelPickerProps {
  kind: GenerationApiKind
  connection: ModelConnection
  value: string
  disabled: boolean
  enabled: boolean
  /** Auto query only saved connection fields; unsaved fields can be queried with the button. */
  autoLoad: boolean
  onChange: (value: string) => void
}

function validConnection(connection: ModelConnection): boolean {
  if (connection.protocol === 'dashscope' && connection.endpoint.trim() === '') return true
  try {
    return ['http:', 'https:'].includes(new URL(connection.endpoint.trim()).protocol)
  } catch { return false }
}

export function ModelPicker({ kind, connection, value, disabled, enabled, autoLoad, onChange }: ModelPickerProps): JSX.Element {
  const [listing, setListing] = useState<ApiModelsResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [all, setAll] = useState(false)
  const [manual, setManual] = useState(false)
  const [requested, setRequested] = useState<{ query: string; kind: GenerationApiKind; count: number } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const serial = useRef(0)
  const query = JSON.stringify(connection)
  const canQuery = enabled && validConnection(connection)
  const refresh = requested?.query === query && requested.kind === kind ? requested.count : 0

  useEffect(() => {
    controller.current?.abort()
    serial.current += 1
    setListing(null)
    setError('')
    setLoading(false)
    setAll(false)
  }, [query, kind])

  useEffect(() => {
    if (!canQuery || (!autoLoad && refresh === 0)) { setLoading(false); return }
    const id = ++serial.current
    const abort = new AbortController()
    controller.current = abort
    const delay = window.setTimeout(() => {
      setLoading(true)
      setError('')
      void api.models(kind, JSON.parse(query) as ModelConnection, abort.signal)
        .then((result) => { if (id === serial.current && !abort.signal.aborted) setListing(result) })
        .catch((reason: unknown) => { if (id === serial.current && !abort.signal.aborted) setError((reason as Error).message) })
        .finally(() => { if (id === serial.current && !abort.signal.aborted) setLoading(false) })
    }, refresh === 0 ? 350 : 0)
    return () => { window.clearTimeout(delay); abort.abort() }
  }, [kind, query, canQuery, autoLoad, refresh])

  const models = listing?.models ?? []
  const filtered = models.filter((model) => model.compatible)
  const choices = all || filtered.length === 0 ? models : filtered
  const known = choices.some((model) => model.id === value)

  return (
    <div className="orb-model-picker">
      <div className="orb-model-controls">
        {manual ? <input className="orb-input" type="text" value={value} disabled={disabled}
          placeholder={tx('填写服务商提供的模型 ID')} autoComplete="off" spellCheck={false}
          onChange={(event) => onChange(event.target.value)} />
          : <select className="orb-select" aria-label={tx('模型名称')} value={value} disabled={disabled}
            onChange={(event) => onChange(event.target.value)}>
            <option value="">{tx('请选择模型（可先获取列表）')}</option>
            {value !== '' && !known ? <option value={value}>{value + tx('（当前配置）')}</option> : null}
            {choices.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
          </select>}
        <button className="orb-btn orb-btn-small" type="button" disabled={disabled || !canQuery || loading}
          onClick={() => setRequested({ query, kind, count: refresh + 1 })}>{loading ? tx('获取中…') : tx('获取模型')}</button>
      </div>
      <div className="orb-model-options">
        <label className="orb-check"><input type="checkbox" checked={manual} disabled={disabled}
          onChange={(event) => setManual(event.target.checked)} /><span className="orb-hint">{tx('手动填写模型')}</span></label>
        {listing?.source === 'api' && filtered.length > 0 && filtered.length < models.length
          ? <label className="orb-check"><input type="checkbox" checked={all} disabled={disabled}
            onChange={(event) => setAll(event.target.checked)} /><span className="orb-hint">{tx('显示全部模型')}</span></label> : null}
      </div>
      {listing !== null ? <span role="status" className="orb-hint">{tx(listing.note)} {tx('列表：')}{choices.length}</span> : null}
      {error !== '' ? <span role="status" className="orb-note orb-note-error">{tx(error)} {tx('可修改模型列表地址后重试，或手动填写。')}</span> : null}
      {listing === null && error === '' ? <span className="orb-hint">{tx('已保存的接口会自动获取模型；新地址和 Key 可先点击「获取模型」，选择后一起保存。')}</span> : null}
    </div>
  )
}
