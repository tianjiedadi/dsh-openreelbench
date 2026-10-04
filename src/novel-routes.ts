import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginRuntime } from './tools.js'
import { prepareNovel, type NovelOptions } from './novel.js'
import { PLATFORMS, type Brief, type Script, type ScenePlan, validateArtifact } from './schema.js'
import { readJson, resolveInProject, toProjectRelative, writeJsonAtomic } from './project.js'
import { readJsonBody, sameOrigin, sendJson } from './http.js'
import { StateViolationError } from './state.js'

interface Server { register(route: { kind: string; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void }

export function mountNovelRoutes(server: Server, runtime: PluginRuntime): Array<() => void> {
  const { machine } = runtime
  return ['preview', 'import', 'apply'].map(action => server.register({
    kind: 'exact', path: '/openreel/novel/' + action,
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'POST only' }); return }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'cross-origin writes are refused' }); return }
        const input = await readJsonBody(request) as Record<string, unknown> | null
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('需要 JSON 请求。')
        if (action === 'apply') {
          const id = String(input.project ?? '')
          const { layout, marker } = await machine.requireProject(id)
          if (marker.novel_import === undefined) throw new Error('当前项目没有小说草稿。')
          if (marker.novel_import.applied_at !== undefined) { sendJson(response, 200, { project: id }); return }
          const scriptCheckpoint = await machine.readCheckpoint(layout, 'script')
          if (scriptCheckpoint?.status === 'completed') throw new Error('脚本已经确认，不能重新覆盖小说草稿。')
          // A retry after a reload failure must not erase edits to the imported script.
          if (scriptCheckpoint?.status === 'awaiting_human') { sendJson(response, 200, { project: id }); return }
          const draft = await readJson<{ script: Script; scenePlan: ScenePlan }>(resolveInProject(layout, marker.novel_import.draft_path))
          if (draft === undefined) throw new Error('小说草稿文件缺失，请重新导入。')
          await machine.write({ projectId: id, stage: 'script', status: 'awaiting_human', artifacts: { script: draft.script, scene_plan: draft.scenePlan }, humanApproved: false, note: '小说已自动分段、分镜，请审核脚本。' })
          await machine.updateProject(id, { novelImport: { ...marker.novel_import, applied_at: new Date().toISOString() } })
          sendJson(response, 200, { project: id }); return
        }
        const name = typeof input.name === 'string' ? input.name : ''
        const source = typeof input.text === 'string' ? input.text : ''
        const options = input.options !== null && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options as Partial<NovelOptions> : {}
        const config = runtime.getConfig()
        const existingId = typeof input.project === 'string' ? input.project : ''
        const existing = existingId === '' ? undefined : await machine.requireProject(existingId)
        const style = typeof input.style === 'string' ? input.style : existing?.marker.style ?? config.defaultStyle
        const platform = String(input.platform ?? existing?.marker.target_platform ?? 'generic')
        if (!(PLATFORMS as readonly string[]).includes(platform)) throw new Error('投放平台无效。')
        const prepared = prepareNovel(source, name, options, style, platform as Brief['target_platform'], typeof input.title === 'string' ? input.title : '')
        if (action === 'preview') { sendJson(response, 200, prepared.preview); return }
        if (!prepared.preview.canImport) throw new Error('所选内容过长，请按预览提示调整章节范围。')
        for (const [artifact, value] of [['brief', prepared.brief], ['script', prepared.script], ['scene_plan', prepared.scenePlan]] as const) {
          const issues = validateArtifact(artifact, value)
          if (issues.length !== 0) throw new Error('小说草稿格式错误：' + JSON.stringify(issues))
        }
        if (existing !== undefined) {
          for (const stage of ['script', 'assets_audio', 'assets_shots', 'compose'] as const) {
            const checkpoint = await machine.readCheckpoint(existing.layout, stage)
            if (checkpoint !== undefined) throw new Error('当前项目已有脚本或素材，请从首页将小说导入为新项目。')
          }
        }
        const project = existing ?? await machine.initProject({ id: 'novel-' + randomUUID().slice(0, 12), title: prepared.brief.title, targetDurationSeconds: prepared.brief.target_duration_seconds, style })
        const { layout } = project
        const dir = join(layout.dir, 'sources', 'novel-' + randomUUID().slice(0, 12))
        await fs.mkdir(dir, { recursive: true })
        const sourcePath = join(dir, /\.md$/i.test(name) ? 'source.md' : 'source.txt')
        const draftPath = join(dir, 'draft.json')
        await fs.writeFile(sourcePath, source, 'utf8')
        await writeJsonAtomic(draftPath, { script: prepared.script, scenePlan: prepared.scenePlan })
        await machine.updateProject(layout.id, {
          title: prepared.brief.title, style, targetPlatform: platform, targetDurationSeconds: prepared.brief.target_duration_seconds,
          novelImport: { name, source_path: toProjectRelative(layout, sourcePath), draft_path: toProjectRelative(layout, draftPath), sections: prepared.preview.sectionCount, shots: prepared.preview.shotCount, duration_seconds: prepared.preview.durationSeconds, first_chapter: prepared.options.firstChapter, last_chapter: prepared.options.lastChapter, imported_at: new Date().toISOString() },
        })
        await machine.write({ projectId: layout.id, stage: 'brief', status: 'awaiting_human', artifacts: { brief: prepared.brief }, humanApproved: false, note: '小说导入完成；确认立项后加载分段与分镜草稿。' })
        sendJson(response, 200, { project: layout.id })
      } catch (error) {
        sendJson(response, error instanceof StateViolationError && error.code !== 'BAD_REQUEST' ? 409 : 400, { error: (error as Error).message })
      }
    },
  }))
}
