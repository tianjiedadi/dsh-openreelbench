/** Normalize gateway URLs users commonly paste from a provider dashboard. */
export function normalizeApiUrl(value: string): string {
  const raw = value.trim()
  if (raw === '') return ''
  let url: URL
  try { url = new URL(raw) } catch { return raw }
  // Some dashboards append their route marker to the API version, producing
  // `/v1de/v1/...`; collapse that harmless paste error before requesting it.
  let path = url.pathname.replace(/\/v1de(?=\/|$)/ig, '/v1')
  path = path.replace(/\/v(\d+)\/v\1(?=\/|$)/ig, '/v$1')
  url.pathname = path.replace(/\/\/+/g, '/')
  return url.href
}

export function appendModelsPath(value: string): string {
  const normalized = normalizeApiUrl(value)
  if (normalized === '') return normalized
  const url = new URL(normalized)
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || /\/v\d+$/i.test(path)) url.pathname = (path || '/v1') + '/models'
  return url.href
}
