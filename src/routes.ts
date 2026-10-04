/**
 * Browser-facing HTTP routes — the data plane behind the two panels.
 *
 *   GET  /openreel/catalog              pipelines and styles the panels offer
 *   GET  /openreel/state?project=<id>   everything OpenReel 创意台 renders
 *   GET  /openreel/media?project&path   preview and download, Range-aware
 *   GET  /openreel/library              创意台看板's project → category → file tree
 *   POST /openreel/project              rename / retime / restyle a project
 *   POST /openreel/project/remove       move a project into .trash
 *   GET  /openreel/trash                what is in the trash
 *   POST /openreel/trash/restore        put one back
 *   POST /openreel/trash/purge          delete one for real
 *   POST /openreel/import               pull generated media into the project
 *   POST /openreel/asset/trim           cut an asset's head and tail with ffmpeg
 *   POST /openreel/asset/restore        put a trimmed asset back the way it was
 *   POST /openreel/validate             check an artifact without writing it
 *   GET  /openreel/cuts?project=        edit versions of the finished film
 *   POST /openreel/cuts                 save one
 *   POST /openreel/cuts/delete          drop one
 *   POST /openreel/generate              generate media through a configured API
 *   POST /openreel/stage                a panel's submit button
 *
 * Three of the four are reads. The one write goes through `StateMachine.write()`
 * — the same function `openreel_stage` calls — and that is the whole point: the
 * panel is allowed to advance the pipeline, but not to reach past the schema,
 * asset, gate and prerequisite checks while doing it. A route that wrote
 * `checkpoints/*.json` directly would be quicker and would quietly delete the
 * governance this plugin exists to provide.
 *
 * Every path from the client is resolved with `resolveInProject`, so `..` and
 * absolute paths are rejected before they reach the filesystem.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'
import { promises as fs } from 'node:fs'

import {
  type ArtifactName, type AssetManifest, type AssetRecord, type ScenePlan, type SceneShot, type Script,
  PLATFORMS, formatIssues, validateArtifact,
} from './schema.js'
import { ProjectError, type ProjectLayout, resolveInProject, toProjectRelative } from './project.js'
import { listPlaybooks, resolvePlaybook } from './playbooks.js'
import { buildScenePrompts } from './prompt.js'
import { checkSceneVariation } from './variation.js'
import { scoreSlideshowRisk } from './slideshow.js'
import {
  AssetError, IMPORT_KINDS, type ImportKind, type ImportRequest,
  importAssets, listTrimmedAudio, musicPatchOf, restoreAudioAsset, trimAudioAsset,
} from './assets.js'
import { MIX_BOUNDS } from './audio-mix.js'
import { CONTENT_LANGUAGE_IDS, resolveContentLanguage } from './content-language.js'
import { resolveVideoProfile } from './media-profile.js'
import { type GenerationSize, generationSizeError, resolveGenerationSize, videoSecondsError } from './generation-size.js'
import { listPipelines, resolvePipeline } from './pipelines.js'
import { planSections } from './compose.js'
import { type ComposeResultPayload, composeProject } from './render-job.js'
import { GenerationApiError, generateImage, generateVideo, generateVoice } from './generation-api.js'
import { discoverApiModels } from './api-models.js'
import { mountNovelRoutes } from './novel-routes.js'
import { checkVisualReferences, saveVisualReference, REFERENCE_MAX_BYTES, type VisualReferences } from './visual-references.js'
import type { ApiEndpointConfig, VoiceApiConfig } from './config.js'
import { CutError, type Cut, deleteCut, listCuts, parseCut, readCut, writeCut } from './cuts.js'
import { STAGES, STAGE_ARTIFACT, StateViolationError, isStage, isStatus } from './state.js'
import type { PluginRuntime } from './tools.js'
import {
  errorMessage,
  mediaKindOf,
  mediaUrl,
  query,
  readJsonBody,
  sameOrigin,
  sendFile,
  sendJson,
} from './http.js'

interface WebServer {
  register(route: {
    kind: string
    path: string
    handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
  }): () => void
}

/** Map a StateViolationError's code onto the status a browser should see. */
function statusForViolation(code: string): number {
  if (code === 'NO_PROJECT') return 404
  if (code === 'BAD_REQUEST' || code === 'SCHEMA_INVALID') return 400
  // Gate, prerequisite, missing asset, coverage and quality failures are all
  // "the request was understood but the pipeline refuses it".
  return 409
}

function fail(response: ServerResponse, error: unknown): void {
  // A rejected path is a bad request, not a server fault — the client asked
  // for something outside the project and was told no.
  if (error instanceof AssetError) {
    sendJson(response, 400, { error: error.message, code: 'ASSET_ERROR' })
    return
  }
  if (error instanceof CutError) {
    sendJson(response, 400, { error: error.message, code: 'BAD_CUT' })
    return
  }
  if (error instanceof GenerationApiError) {
    sendJson(response, 502, { error: error.message, code: 'GENERATION_API_FAILED' })
    return
  }
  if (error instanceof ProjectError) {
    sendJson(response, 400, { error: error.message, code: 'BAD_PATH' })
    return
  }
  if (error instanceof StateViolationError) {
    sendJson(response, statusForViolation(error.code), { error: error.message, code: error.code })
    return
  }
  sendJson(response, 500, { error: errorMessage(error) })
}

/* ------------------------------------------------------------------- state */

const ARTIFACTS: readonly ArtifactName[] = [
  'brief', 'script', 'scene_plan', 'asset_manifest_audio', 'asset_manifest_shots', 'render_report',
]

/* -------------------------------------------------------------- scene plan */

/**
 * The scene plan as the shots screen has always read it: section id -> entries.
 *
 * A lossy projection on purpose. The screen wants a count and a couple of
 * fields per shot; the artifact carries more than that. Widening this view is
 * how shot language reaches the UI later, and until then the extra fields ride
 * along on disk untouched — which is exactly what `mergeSectionShots` below is
 * for.
 */
function shotPlanView(plan: ScenePlan): Record<string, Array<{ prompt?: string; weight?: number }>> {
  const view: Record<string, Array<{ prompt?: string; weight?: number }>> = {}
  const ordered = [...plan.shots].sort((a, b) => a.shot_index - b.shot_index)
  for (const shot of ordered) {
    const list = view[shot.section_id] ?? []
    list.push({
      ...(shot.prompt === undefined ? {} : { prompt: shot.prompt }),
      ...(shot.weight === undefined ? {} : { weight: shot.weight }),
    })
    view[shot.section_id] = list
  }
  return view
}

/** Lift a pre-artifact plan off the marker, so nothing is lost on first write. */
function fromMarkerPlan(
  marker: Record<string, Array<{ prompt?: string; weight?: number }>>,
): ScenePlan {
  const shots: SceneShot[] = []
  for (const [sectionId, entries] of Object.entries(marker)) {
    entries.forEach((entry, index) => {
      shots.push({
        id: sectionId + '-' + index,
        section_id: sectionId,
        shot_index: index,
        ...(entry.prompt === undefined || entry.prompt.trim() === '' ? {} : { prompt: entry.prompt }),
        ...(entry.weight === undefined ? {} : { weight: entry.weight }),
      })
    })
  }
  return { version: '1.0', shots }
}

/**
 * The plan to reason from when nobody has written one down.
 *
 * Five-layer prompts, the variation report and the slideshow score all read a
 * scene plan. Requiring one to be SAVED first meant that on a normal run —
 * where the script names a visual per section and nobody opens the shot editor
 * — none of the three engaged at all, and the generation request fell back to
 * bare prompts. The plan is derivable: the timeline already says how many
 * pictures each section gets, and the script already says what each is of.
 *
 * Derived, never written. A stored plan always wins, and this exists so the
 * absence of one does not silently switch off three checks. The prompt
 * fallback rule mirrors the panel's own — the section's visual seeds its FIRST
 * shot only, because that is the one the script's single idea belongs to.
 */
function derivedScenePlan(
  timeline: ReadonlyArray<{ sectionId: string; shots: ReadonlyArray<{ index: number }> }>,
  markerPlan: Record<string, Array<{ prompt?: string; weight?: number }>> | undefined,
  subjects: ReadonlyMap<string, string>,
): ScenePlan {
  const shots: SceneShot[] = []
  for (const timing of timeline) {
    const planned = markerPlan?.[timing.sectionId]
    const count = Math.max(planned?.length ?? 0, timing.shots.length, 1)
    for (let index = 0; index < count; index += 1) {
      const entry = planned?.[index]
      const prompt = entry?.prompt ?? (index === 0 ? subjects.get(timing.sectionId) : undefined)
      shots.push({
        id: timing.sectionId + '-' + index,
        section_id: timing.sectionId,
        shot_index: index,
        ...(prompt === undefined || prompt.trim() === '' ? {} : { prompt: prompt.trim() }),
        ...(entry?.weight === undefined ? {} : { weight: entry.weight }),
      })
    }
  }
  return { version: '1.0', shots }
}

/**
 * Replace one section's shots, keeping whatever the caller did not mention.
 *
 * The incoming list is authoritative for how many shots there are and what
 * order they come in. It is NOT authoritative for fields it omits: a panel that
 * only knows about prompts must not silently strip the lens choice off a shot
 * because it had no box to show it in. Surviving shots are matched by position,
 * which is what "the third picture in this section" means to everyone looking
 * at the screen.
 */
function mergeSectionShots(
  existing: ScenePlan | undefined,
  sectionId: string,
  incoming: ReadonlyArray<Record<string, unknown>>,
): ScenePlan {
  const others = (existing?.shots ?? []).filter((shot) => shot.section_id !== sectionId)
  const previous = (existing?.shots ?? [])
    .filter((shot) => shot.section_id === sectionId)
    .sort((a, b) => a.shot_index - b.shot_index)

  const shots: SceneShot[] = incoming.map((entry, index) => {
    const kept = previous[index]
    const merged: SceneShot = {
      ...(kept ?? {}),
      id: typeof entry.id === 'string' && entry.id.trim() !== ''
        ? entry.id.trim()
        : kept?.id ?? sectionId + '-' + index,
      section_id: sectionId,
      shot_index: index,
    }
    // `undefined` means "not mentioned" and keeps what is there; an empty
    // string or null is the caller actually clearing the field.
    if ('prompt' in entry) {
      const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : ''
      if (prompt === '') delete merged.prompt
      else merged.prompt = prompt
    }
    if ('weight' in entry) {
      const weight = entry.weight
      if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) merged.weight = weight
      else delete merged.weight
    }
    // Every optional field of SceneShot beyond prompt and weight. A field
    // missing from this list is silently dropped on save: the panel sends it,
    // the route ignores it, and the control looks broken with nothing logged.
    // `hero_moment` was exactly that until it was noticed by hand.
    for (const key of ['shot_language', 'texture_keywords', 'reference_names', 'hero_moment'] as const) {
      if (!(key in entry)) continue
      const value = entry[key]
      if (value === null || value === undefined || value === false) delete merged[key]
      else Object.assign(merged, { [key]: value })
    }
    return merged
  })

  return { version: '1.0', shots: [...others, ...shots] }
}

/* ----------------------------------------------------------------- library */

interface LibraryFile {
  name: string
  path: string
  kind: string
  bytes: number
  modified: string
  url: string
  download_url: string
}

/** Walk one directory tree, bounded so a stray symlink cannot run away. */
async function walk(root: string, layout: ProjectLayout, depth = 0): Promise<LibraryFile[]> {
  if (depth > 4) return []
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const files: LibraryFile[] = []
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(absolute, layout, depth + 1))
      continue
    }
    if (!entry.isFile()) continue
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (stat === undefined) continue
    const relative = toProjectRelative(layout, absolute)
    files.push({
      name: entry.name,
      path: relative,
      kind: mediaKindOf(entry.name),
      bytes: stat.size,
      modified: stat.mtime.toISOString(),
      url: mediaUrl(layout.id, relative),
      download_url: mediaUrl(layout.id, relative, true),
    })
  }
  return files
}

/**
 * One project's files, grouped the way the board shows them: the generated
 * material by medium, and the finished film on its own.
 *
 * Grouping by detected medium rather than by directory means a pipeline that
 * starts writing clips into `assets/` gets a "video" group without this code
 * changing.
 */
async function libraryEntry(layout: ProjectLayout, title: string, createdAt: string): Promise<unknown> {
  const assets = await walk(layout.assetsDir, layout)
  const outputs = await walk(layout.outputDir, layout)
  const groups: Record<string, LibraryFile[]> = { audio: [], image: [], video: [], other: [] }
  for (const file of assets) (groups[file.kind] ?? groups.other!).push(file)
  for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name))
  outputs.sort((a, b) => a.name.localeCompare(b.name))

  const categories = [
    { id: 'audio', label: '音频', files: groups.audio! },
    { id: 'image', label: '图片', files: groups.image! },
    { id: 'video', label: '视频', files: groups.video! },
    { id: 'final', label: '成片', files: outputs },
  ].filter((category) => category.files.length > 0)

  const total = [...assets, ...outputs].reduce((sum, file) => sum + file.bytes, 0)
  return { id: layout.id, title, created_at: createdAt, total_bytes: total, categories }
}

/* --------------------------------------------------------------- mounting */

/** One project's render, while it runs and after it stops. */
interface RenderJob {
  state: 'running' | 'done' | 'failed'
  /** The composer's own progress line, shown verbatim on the page. */
  progress: string
  /** 0..1 through the render. See PHASE_SPAN for how honest that is. */
  fraction: number
  phase: string
  /** When the render started, so the page can show how long it has been. */
  startedAt: number
  controller: AbortController
  result?: ComposeResultPayload
  error?: string
  code?: string
}

/** Just the part of the host's skill registry this file asks about. */
interface SkillCatalog {
  list?: (options: Record<string, unknown>) => Promise<Array<{
    name: string
    invocation?: { userInvocable?: boolean }
  }>>
}

export function mountStudioRoutes(ctx: Context, runtime: PluginRuntime): (() => void) | undefined {
  const webServer = ctx.get('webServer') as WebServer | undefined
  if (webServer === undefined) return undefined

  const disposers: Array<() => void> = []
  const { machine } = runtime
  disposers.push(...mountNovelRoutes(webServer, runtime))

  /**
   * In-flight renders, one per project.
   *
   * Held in memory rather than on disk on purpose: a job is a fact about THIS
   * host process, and a stale 'running' entry surviving a restart would leave a
   * project permanently unable to render. Losing the record of a finished
   * render costs nothing — the report is already in the checkpoint.
   */
  const renders = new Map<string, RenderJob>()
  disposers.push(() => {
    // Unloading the plugin mid-encode should stop ffmpeg, not orphan it.
    for (const job of renders.values()) job.controller.abort()
    renders.clear()
  })

  // ---- GET /openreel/skill?name= -------------------------------------------
  //
  // Whether the host's skill registry resolves one name, and whether a `/name`
  // gesture would load it.
  //
  // A panel that opens its request with `/some-skill` is depending on the host
  // to splice that body in before the step. When the name does not resolve the
  // host leaves it as ordinary prose — no error anywhere — and the model
  // proceeds with none of the guidance the request was built around. It still
  // answers, so the failure looks like a bad answer rather than a missing
  // skill. This route is how a panel refuses to send instead.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/skill',
    handler: async (request, response) => {
      try {
        const name = query(request).get('name') ?? ''
        if (name === '') {
          sendJson(response, 400, { error: 'name is required' })
          return
        }
        const skills = ctx.get('skills') as SkillCatalog | undefined
        if (skills?.list === undefined) {
          // No registry at all is not the same as a missing skill, and saying
          // "unavailable" would send the panel down the wrong explanation.
          sendJson(response, 200, { name, known: false, loadable: false, registry: false })
          return
        }
        const found = (await skills.list({})).find((entry) => entry.name === name)
        sendJson(response, 200, {
          name,
          registry: true,
          known: found !== undefined,
          // The gesture checks exactly this, so this route must too.
          loadable: found?.invocation?.userInvocable === true,
        })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- GET /openreel/state -------------------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/state',
    handler: async (request, response) => {
      try {
        const projectId = query(request).get('project')
        if (projectId === null || projectId === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        const status = await machine.status(projectId)
        const layout = machine.layout(projectId)
        const config = runtime.getConfig()
        const { playbook, resolved, fallback } = resolvePlaybook(status.project.style, config.playbooks)

        const artifacts: Record<string, unknown> = {}
        for (const name of ARTIFACTS) {
          const value = await machine.readArtifact<unknown>(layout, name)
          // Served verbatim. The panel edits these artifacts and submits them
          // back, so anything added here for display would come back as an
          // unrecognised field — a route that decorates a document it also
          // accepts has made that document impossible to round-trip.
          if (value !== undefined) artifacts[name] = value
        }

        // The planned timeline, so the panel shows real on-screen times rather
        // than reimplementing the pacing rules in the browser.
        const script = artifacts.script as Script | undefined
        const audio = artifacts.asset_manifest_audio as AssetManifest | undefined
        const shots = artifacts.asset_manifest_shots as AssetManifest | undefined
        const cuts = await listCuts(layout)
        const activeCut = cuts.find((entry) => entry.id === (query(request).get('cut') ?? '')) ?? undefined
        const plan = script === undefined
          ? []
          : planSections(script, {
            version: '1.0',
            assets: [...(audio?.assets ?? []), ...(shots?.assets ?? [])],
          }, playbook, activeCut)

        const report = artifacts.render_report as { outputs?: Array<{ path?: unknown }> } | undefined
        const filmPath = typeof report?.outputs?.[0]?.path === 'string' ? report.outputs[0].path : undefined

        const pipeline = resolvePipeline(status.project.pipeline)

        // `project.shot_plan` is now a VIEW, not storage.
        //
        // The plan lives in the scene_plan artifact, where it is schema-checked
        // and can carry shot language. Projects created before that artifact
        // existed still have theirs on the marker, so the marker is the
        // fallback rather than the source. Panels read one shape either way.
        const scenePlan = artifacts.scene_plan as ScenePlan | undefined

        // Built prompts, five layers deep, computed here rather than in the
        // browser: the same function the model is told to rely on, so the
        // panel and the generation request cannot describe different pictures.
        //
        // A separate top-level key, NOT part of `artifacts`. Those are served
        // verbatim because the panel submits them back, and a derived field
        // inside one would come back as an unrecognised member.
        const subjects = new Map<string, string>()
        for (const section of script?.sections ?? []) {
          const visual = section.visual as { prompt?: unknown } | undefined
          if (typeof visual?.prompt === 'string' && visual.prompt.trim() !== '') {
            subjects.set(section.id, visual.prompt.trim())
          }
        }
        // Everything derived below reads the EFFECTIVE plan: the stored one if
        // there is one, otherwise the one the timeline and script already
        // imply. Gating on a saved plan meant a normal run — script written,
        // shot editor never opened — got no five-layer prompts and neither
        // check, which made all three look broken rather than absent.
        const effectivePlan = scenePlan ?? derivedScenePlan(plan, status.project.shot_plan, subjects)

        const prompts = plan.length === 0 ? [] : buildScenePrompts(effectivePlan.shots, playbook, subjects)
        // Advisory, computed on every read so the panel can show it before the
        // generate button rather than after the bill.
        const variation = plan.length === 0 ? null : checkSceneVariation(effectivePlan.shots, subjects)

        // Scored against the timeline the panel is about to draw, so the number
        // on the compose screen is the number compose will refuse on.
        const slideshow = plan.length === 0
          ? null
          : scoreSlideshowRisk(effectivePlan.shots, plan, playbook, subjects)

        // The view follows the effective plan too. Serving it off the stored
        // plan alone dropped every section that plan did not mention — a
        // project whose marker held prompts for three sections lost two of
        // them the moment one section was saved into the artifact.
        const project = plan.length === 0
          ? status.project
          : { ...status.project, shot_plan: shotPlanView(effectivePlan) }

        sendJson(response, 200, {
          project,
          pipeline: { id: pipeline.resolved, fallback: pipeline.fallback, definition: pipeline.pipeline },
          style: { id: resolved, fallback, playbook, options: listPlaybooks(config.playbooks) },
          stages: status.stages.map((stage) => ({ ...stage, artifact_name: STAGE_ARTIFACT[stage.stage] })),
          next_stage: status.next_stage,
          awaiting_approval: status.awaiting_approval,
          artifacts,
          timeline: plan,
          prompts,
          variation,
          slideshow,
          cuts,
          film: filmPath === undefined ? null : { path: filmPath, url: mediaUrl(projectId, filmPath) },
          bindings: config.bindings,
          providers: {
            visual: status.project.visual_provider ?? config.generation.visualProvider,
            visual_mode: status.project.visual_mode ?? config.generation.visualMode,
            voice: status.project.voice_provider ?? config.generation.voiceProvider,
            defaults: {
              visual: config.generation.visualProvider,
              visual_mode: config.generation.visualMode,
              voice: config.generation.voiceProvider,
            },
            api: {
              image: { configured: config.generation.api.image.endpoint.trim() !== '', model: config.generation.api.image.model },
              video: { configured: config.generation.api.video.endpoint.trim() !== '', model: config.generation.api.video.model },
              voice: { configured: config.generation.api.voice.protocol === 'dashscope' || config.generation.api.voice.endpoint.trim() !== '', model: config.generation.api.voice.model },
            },
          },
          // The frame, resolved once and served: the platform's baseline times
          // the render scale. The shots screen needs the SAME numbers compose
          // will cut to — a panel that worked them out again in the browser is
          // exactly how a vertical project ended up with 16:9 stills.
          frame: (() => {
            const platformFrame = resolveVideoProfile(
              status.project.target_platform
                ?? (typeof (artifacts.brief as { target_platform?: unknown } | undefined)?.target_platform === 'string'
                  ? (artifacts.brief as { target_platform: string }).target_platform
                  : undefined),
              config.video.renderScale,
              config.video.fps,
            )
            const provider = status.project.visual_provider ?? config.generation.visualProvider
            const mode = status.project.visual_mode ?? config.generation.visualMode
            const custom = provider === 'api' ? status.project.api_visual_sizes?.[mode] : undefined
            return custom === undefined ? platformFrame : {
              ...platformFrame,
              width: custom.width,
              height: custom.height,
              source: 'default' as const,
              shape: '自定义 ' + custom.width + '×' + custom.height,
              label: '自定义 ' + custom.width + '×' + custom.height,
            }
          })(),
          // Which takes have a pre-trim copy on disk, so the panel can offer
          // undo on exactly those. A separate top-level key rather than a flag
          // inside the manifest, for the same reason `prompts` is one: the
          // manifest is served verbatim and submitted back.
          trimmed: await listTrimmedAudio(layout),
          // What language this film is in: the project's own choice, or the
          // panel's language when it has never made one. Resolved host-side so
          // the screens and the requests they compose cannot disagree.
          contentLanguage: resolveContentLanguage(status.project.language, config.language).id,
        })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- GET /openreel/catalog -----------------------------------------------
  // What the welcome screen offers and what the project screen picks from.
  // Static for now, but a route rather than a constant in the bundle so a
  // custom playbook added to config shows up without rebuilding the client.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/catalog',
    handler: async (_request, response) => {
      try {
        sendJson(response, 200, {
          pipelines: listPipelines(),
          styles: listPlaybooks(runtime.getConfig().playbooks),
          default_duration_seconds: runtime.getConfig().defaultDurationSeconds,
        })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/project ----------------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/project',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object') {
          sendJson(response, 400, { error: 'a JSON object body is required' })
          return
        }
        const input = body as Record<string, unknown>
        if (typeof input.project !== 'string' || input.project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        const patch: {
          title?: string
          language?: string
          targetDurationSeconds?: number
          style?: string
          voice?: string
          visualProvider?: 'comfyui' | 'api'
          visualMode?: 'image' | 'video'
          apiVisualSize?: { mode: 'image' | 'video'; size: GenerationSize | null }
          apiVideoSeconds?: number | null
          voiceProvider?: 'comfyui' | 'api'
          voiceDesignName?: string
          voiceDesignPrompt?: string
          loraName?: string
          loraStrength?: number
          references?: string[]
          voiceReferences?: string[]
          voiceReferencePaths?: string[]
          apiVisualReferences?: { mode: 'image' | 'video'; value: VisualReferences }
          music?: {
            path?: string; workflow?: string; prompt?: string
            gain_db?: number; fade_in?: number; fade_out?: number
          }
          targetPlatform?: string
          shotPlan?: Record<string, Array<{ prompt?: string; weight?: number }>>
        } = {}
        if (typeof input.title === 'string' && input.title.trim() !== '') patch.title = input.title.trim()
        if (typeof input.style === 'string' && input.style.trim() !== '') patch.style = input.style.trim()
        if (typeof input.voice === 'string') patch.voice = input.voice.trim()
        if (input.visual_provider === 'comfyui' || input.visual_provider === 'api') {
          patch.visualProvider = input.visual_provider
        }
        if (input.visual_mode === 'image' || input.visual_mode === 'video') {
          patch.visualMode = input.visual_mode
        }
        if ('api_visual_size' in input) {
          const setting = input.api_visual_size
          if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
            sendJson(response, 400, { error: 'api_visual_size must contain mode and size' }); return
          }
          const entry = setting as Record<string, unknown>
          if (entry.mode !== 'image' && entry.mode !== 'video') {
            sendJson(response, 400, { error: 'api_visual_size.mode must be image or video' }); return
          }
          if (entry.size === null) patch.apiVisualSize = { mode: entry.mode, size: null }
          else {
            const error = generationSizeError(entry.size)
            if (error !== undefined) { sendJson(response, 400, { error }); return }
            const size = entry.size as GenerationSize
            patch.apiVisualSize = { mode: entry.mode, size: { width: size.width, height: size.height } }
          }
        }
        if ('api_video_seconds' in input) {
          if (input.api_video_seconds === null) patch.apiVideoSeconds = null
          else {
            const error = videoSecondsError(input.api_video_seconds)
            if (error !== undefined) { sendJson(response, 400, { error }); return }
            patch.apiVideoSeconds = input.api_video_seconds as number
          }
        }
        if (input.voice_provider === 'comfyui' || input.voice_provider === 'api') {
          patch.voiceProvider = input.voice_provider
        }
        if ('api_visual_references' in input) {
          const setting = input.api_visual_references as { mode?: unknown; value?: unknown } | null
          if (setting === null || typeof setting !== 'object' || (setting.mode !== 'image' && setting.mode !== 'video')) {
            sendJson(response, 400, { error: '参考素材须指定图片或视频模式。' }); return
          }
          const { layout } = await machine.requireProject(input.project)
          patch.apiVisualReferences = { mode: setting.mode, value: await checkVisualReferences(layout, setting.mode, setting.value) }
        }
        if (typeof input.language === 'string') {
          const language = input.language.trim()
          // Checked rather than trusted: this steers what the model writes, so
          // a value nothing recognises would silently mean "Chinese" and the
          // panel would go on showing the language the user picked.
          if (!CONTENT_LANGUAGE_IDS.includes(language)) {
            sendJson(response, 400, {
              error: 'language must be one of ' + CONTENT_LANGUAGE_IDS.join(', ')
                + ', got ' + JSON.stringify(language),
            })
            return
          }
          patch.language = language
        }
        if (typeof input.voice_design_name === 'string') patch.voiceDesignName = input.voice_design_name.trim()
        if (typeof input.voice_design_prompt === 'string') patch.voiceDesignPrompt = input.voice_design_prompt.trim()
        if (typeof input.lora_name === 'string') patch.loraName = input.lora_name.trim()
        if (typeof input.target_platform === 'string') {
          const platform = input.target_platform.trim()
          // Checked here rather than trusted: the frame is decided from this
          // value, so a typo would render the wrong shape and say nothing.
          if (!(PLATFORMS as readonly string[]).includes(platform)) {
            sendJson(response, 400, {
              error: 'target_platform must be one of ' + PLATFORMS.join(', ') + ', got ' + JSON.stringify(platform),
            })
            return
          }
          patch.targetPlatform = platform
        }
        // shot_plan is deliberately NOT accepted here any more. It lives in the
        // scene_plan artifact, where the schema can see it; leaving a second
        // way to write it would put the same fact in two places, and the
        // marker copy has no validation to keep it honest.
        //
        // The marker field stays readable so projects that predate the
        // artifact still show their plan until their first save lifts it over.
        if (Array.isArray(input.references)) {
          patch.references = input.references
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '')
        }
        if (Array.isArray(input.voice_references)) {
          patch.voiceReferences = input.voice_references
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '')
        }
        if (Array.isArray(input.voice_reference_paths)) {
          patch.voiceReferencePaths = input.voice_reference_paths
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '')
        }
        if (input.music !== null && typeof input.music === 'object' && !Array.isArray(input.music)) {
          const music = input.music as Record<string, unknown>
          const patchMusic: {
            path?: string; workflow?: string; prompt?: string
            gain_db?: number; fade_in?: number; fade_out?: number
          } = {}
          // Only the keys that were sent. An absent key means "leave it", which
          // is what lets the panel save a workflow name and the agent save a
          // path without either erasing the other.
          if (typeof music.workflow === 'string') patchMusic.workflow = music.workflow.trim()
          if (typeof music.prompt === 'string') patchMusic.prompt = music.prompt.trim()
          if (typeof music.path === 'string') {
            const relative = music.path.trim()
            // Checked here rather than at render time: an absolute path or a
            // `..` segment reaching the marker would be a stored escape route,
            // and compose would report it as a missing file.
            if (relative !== '' && (/^([a-zA-Z]:)?[\\/]/.test(relative) || relative.split(/[\\/]/).includes('..'))) {
              sendJson(response, 400, { error: 'music.path must be relative to the project, got ' + JSON.stringify(relative) })
              return
            }
            patchMusic.path = relative
          }
          // Clamped through the same function the render and the preview use, so
          // an out-of-range value cannot mean one thing on the page and another
          // in the file.
          const bounded = (value: unknown, bound: { min: number; max: number }): number | undefined =>
            typeof value === 'number' && Number.isFinite(value)
              ? Math.min(bound.max, Math.max(bound.min, value))
              : undefined
          const gain = bounded(music.gain_db, MIX_BOUNDS.gainDb)
          if (gain !== undefined) patchMusic.gain_db = gain
          const fadeIn = bounded(music.fade_in, MIX_BOUNDS.fadeInSeconds)
          if (fadeIn !== undefined) patchMusic.fade_in = fadeIn
          const fadeOut = bounded(music.fade_out, MIX_BOUNDS.fadeOutSeconds)
          if (fadeOut !== undefined) patchMusic.fade_out = fadeOut
          if (Object.keys(patchMusic).length > 0) patch.music = patchMusic
        }
        if (typeof input.lora_strength === 'number' && Number.isFinite(input.lora_strength)) {
          patch.loraStrength = Math.min(2, Math.max(0, input.lora_strength))
        }
        if (typeof input.target_duration_seconds === 'number') {
          const seconds = input.target_duration_seconds
          if (!Number.isFinite(seconds) || seconds < 5 || seconds > 1800) {
            sendJson(response, 400, { error: 'target_duration_seconds must be between 5 and 1800' })
            return
          }
          patch.targetDurationSeconds = seconds
        }
        if (Object.keys(patch).length === 0) {
          sendJson(response, 400, { error: 'nothing to update' })
          return
        }
        const marker = await machine.updateProject(input.project, patch)
        sendJson(response, 200, { project: marker })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/project/remove ---------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/project/remove',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = await readJsonBody(request)
        const input = (body ?? {}) as Record<string, unknown>
        if (typeof input.project !== 'string' || input.project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        const { trashedTo } = await machine.removeProject(input.project)
        sendJson(response, 200, { removed: input.project, trashed_to: trashedTo })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- GET /openreel/trash -------------------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/trash',
    handler: async (_request, response) => {
      try {
        sendJson(response, 200, { entries: await machine.listTrash() })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/trash/restore & /openreel/trash/purge -------------------
  for (const [path, run] of [
    ['/openreel/trash/restore', (entry: string) => machine.restoreProject(entry)],
    ['/openreel/trash/purge', (entry: string) => machine.purgeProject(entry)],
  ] as const) {
    disposers.push(webServer.register({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        try {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'POST only' })
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'cross-origin writes are refused' })
            return
          }
          const body = await readJsonBody(request)
          const input = (body ?? {}) as Record<string, unknown>
          if (typeof input.entry !== 'string' || input.entry === '') {
            sendJson(response, 400, { error: 'entry is required' })
            return
          }
          sendJson(response, 200, await run(input.entry))
        } catch (error) {
          fail(response, error)
        }
      },
    }))
  }

  // ---- POST /openreel/scene-plan -------------------------------------------
  // One section's shots at a time, because that is the unit the screen edits.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/scene-plan',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object') {
          sendJson(response, 400, { error: 'a JSON object body is required' })
          return
        }
        const input = body as Record<string, unknown>
        const projectId = typeof input.project === 'string' ? input.project : ''
        const sectionId = typeof input.section === 'string' ? input.section.trim() : ''
        if (projectId === '' || sectionId === '') {
          sendJson(response, 400, { error: 'project and section are required' })
          return
        }
        if (!Array.isArray(input.shots)) {
          sendJson(response, 400, { error: 'shots must be an array' })
          return
        }
        const incoming = input.shots.filter(
          (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
        )

        const { layout, marker } = await machine.requireProject(projectId)
        let existing = await machine.readArtifact<ScenePlan>(layout, 'scene_plan')
        // First write on a project that predates the artifact: bring the
        // marker's plan across so the sections nobody is editing survive.
        if (existing === undefined && marker.shot_plan !== undefined) {
          existing = fromMarkerPlan(marker.shot_plan)
        }

        const plan = mergeSectionShots(existing, sectionId, incoming)
        await machine.writePlan(projectId, 'scene_plan', plan)
        sendJson(response, 200, { scene_plan: plan })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- cuts --------------------------------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/cuts',
    handler: async (request, response) => {
      try {
        if (request.method === 'GET') {
          const projectId = query(request).get('project')
          if (projectId === null || projectId === '') {
            sendJson(response, 400, { error: 'project is required' })
            return
          }
          const { layout } = await machine.requireProject(projectId)
          sendJson(response, 200, { cuts: await listCuts(layout) })
          return
        }
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'GET or POST' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object') {
          sendJson(response, 400, { error: 'a JSON object body is required' })
          return
        }
        const input = body as Record<string, unknown>
        if (typeof input.project !== 'string' || input.project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        const { layout } = await machine.requireProject(input.project)
        const cutInput = (input.cut ?? {}) as Record<string, unknown>
        const id = typeof cutInput.id === 'string' ? cutInput.id.trim() : ''
        // Editing an existing version keeps its creation time and its render,
        // so a saved cut's history is not reset by a tweak.
        const existing = id === '' ? undefined : await readCut(layout, id).catch(() => undefined)
        const saved = await writeCut(layout, parseCut(cutInput, existing))
        sendJson(response, 200, { cut: saved })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/cuts/delete',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = (await readJsonBody(request) ?? {}) as Record<string, unknown>
        if (typeof body.project !== 'string' || typeof body.cut !== 'string') {
          sendJson(response, 400, { error: 'project and cut are required' })
          return
        }
        const { layout } = await machine.requireProject(body.project)
        await deleteCut(layout, body.cut)
        sendJson(response, 200, { deleted: body.cut })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- GET /openreel/media -------------------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/media',
    handler: async (request, response) => {
      try {
        const params = query(request)
        const projectId = params.get('project')
        const path = params.get('path')
        if (projectId === null || path === null) {
          sendJson(response, 400, { error: 'project and path are required' })
          return
        }
        const { layout } = await machine.requireProject(projectId)
        // Rejects absolute paths and any `..` segment before touching disk.
        const absolute = resolveInProject(layout, path)
        await sendFile(request, response, absolute, {
          download: params.get('download') === '1',
          filename: path.split('/').pop() ?? 'file',
        })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- GET /openreel/library ----------------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/library',
    handler: async (request, response) => {
      try {
        const only = query(request).get('project')
        const summaries = await machine.listProjects()
        const wanted = only === null || only === ''
          ? summaries
          : summaries.filter((summary) => summary.id === only)
        const projects = []
        for (const summary of wanted) {
          projects.push(await libraryEntry(machine.layout(summary.id), summary.title, summary.created_at))
        }
        sendJson(response, 200, { projects })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact', path: '/openreel/reference/file',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'POST only' }); return }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'cross-origin writes are refused' }); return }
        const params = query(request)
        const kind = params.get('kind')
        if (kind !== 'image' && kind !== 'video') { sendJson(response, 400, { error: 'kind must be image or video' }); return }
        const { layout } = await machine.requireProject(params.get('project') ?? '')
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          length += bytes.length
          if (length > REFERENCE_MAX_BYTES) { sendJson(response, 413, { error: '参考素材超过 20 MB。' }); return }
          chunks.push(bytes)
        }
        const file = await saveVisualReference(layout, kind, params.get('name') ?? '', Buffer.concat(chunks))
        sendJson(response, 200, { ...file, url: mediaUrl(layout.id, file.path) })
      } catch (error) { sendJson(response, 400, { error: (error as Error).message }) }
    },
  }))

  // ---- GET /openreel/references ---------------------------------------------
  // Project-local reference media is the API-provider counterpart to the
  // ComfyUI input directory. Keeping it in the project lets API voice mode work
  // without dsh-comfyui at all.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/references',
    handler: async (request, response) => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'GET only' })
          return
        }
        const project = query(request).get('project') ?? ''
        if (project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        const { layout } = await machine.requireProject(project)
        const kind = query(request).get('kind') ?? 'voice'
        if (!['voice', 'image', 'video'].includes(kind)) { sendJson(response, 400, { error: 'invalid reference kind' }); return }
        const directory = join(layout.assetsDir, 'references', kind)
        await fs.mkdir(directory, { recursive: true })
        const entries = await fs.readdir(directory, { withFileTypes: true })
        const files = []
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const path = toProjectRelative(layout, join(directory, entry.name))
          files.push({ name: entry.name, path, url: mediaUrl(project, path) })
        }
        files.sort((a, b) => a.name.localeCompare(b.name))
        sendJson(response, 200, { files })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/reference ---------------------------------------------
  // The browser sends base64 JSON so this route does not depend on a multipart
  // parser or on dsh-comfyui's upload endpoint.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/reference',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(response, 400, { error: 'a JSON object body is required' })
          return
        }
        const input = body as Record<string, unknown>
        const project = typeof input.project === 'string' ? input.project.trim() : ''
        const kind = typeof input.kind === 'string' ? input.kind : ''
        const original = typeof input.name === 'string' ? basename(input.name).trim() : ''
        const encoded = typeof input.data === 'string' ? input.data : ''
        if (project === '' || kind !== 'voice' || original === '' || encoded === '') {
          sendJson(response, 400, { error: 'project, kind=voice, name and base64 data are required' })
          return
        }
        if (encoded.length > 80_000_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
          sendJson(response, 400, { error: 'reference audio must be base64 and smaller than 60 MB' })
          return
        }
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.length === 0) {
          sendJson(response, 400, { error: 'reference audio is empty' })
          return
        }
        const { layout } = await machine.requireProject(project)
        await fs.mkdir(layout.voiceReferencesDir, { recursive: true })
        const cleaned = original.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'voice-reference'
        const originalExtension = extname(cleaned)
        const extension = originalExtension === '' ? '.wav' : originalExtension
        let name = cleaned + (originalExtension === '' ? extension : '')
        let index = 2
        while (await fs.access(join(layout.voiceReferencesDir, name)).then(() => true, () => false)) {
          const stem = originalExtension === '' ? cleaned : cleaned.slice(0, -originalExtension.length)
          name = stem + '-' + index + extension
          index += 1
        }
        const absolute = join(layout.voiceReferencesDir, name)
        await fs.writeFile(absolute, bytes)
        const path = toProjectRelative(layout, absolute)
        sendJson(response, 200, { name, path, url: mediaUrl(project, path) })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/import -----------------------------------------------
  // The panel generates through dsh-comfyui's own routes and gets back a media
  // URL; this is how that URL becomes a file inside the project, under the same
  // naming rule the tool uses.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/import',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const input = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>
        if (typeof input.project !== 'string' || input.project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        const items = input.items
        if (!Array.isArray(items) || items.length === 0) {
          sendJson(response, 400, { error: 'items must be a non-empty array' })
          return
        }
        const { layout } = await machine.requireProject(input.project)
        const script = await machine.readArtifact<{ sections: Array<{ id: string }> }>(layout, 'script')
        if (script === undefined) {
          sendJson(response, 409, {
            error: '还没有脚本，素材文件名按段落顺序生成，先确认脚本再导入。',
            code: 'PREREQUISITE_VIOLATION',
          })
          return
        }
        const parsed: ImportRequest[] = items.map((item) => {
          const record = (item ?? {}) as Record<string, unknown>
          const kind = String(record.kind ?? '')
          if (!(IMPORT_KINDS as readonly string[]).includes(kind)) {
            throw new AssetError('kind must be one of ' + IMPORT_KINDS.join(' | '))
          }
          if (kind === 'music') {
            return { source: String(record.source ?? ''), kind: 'music' as ImportKind }
          }
          return {
            source: String(record.source ?? ''),
            kind: kind as ImportKind,
            sceneId: String(record.scene_id ?? ''),
          }
        })
        const order = new Map(script.sections.map((section, index) => [section.id, index + 1]))
        const imported = await importAssets(layout, order, parsed, AbortSignal.timeout(180_000))
        // Importing the bed and recording it are one gesture -- see `musicPatchOf`.
        const musicPatch = musicPatchOf(imported)
        if (musicPatch !== undefined) await machine.updateProject(input.project, { music: musicPatch })
        sendJson(response, 200, { imported })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/asset/trim -------------------------------------------
  // The browser picks the in and out points off a waveform; the cut itself is
  // ffmpeg's job, because only the host can write the file.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/asset/trim',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const input = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>
        if (typeof input.project !== 'string' || input.project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        if (typeof input.path !== 'string' || input.path === '') {
          sendJson(response, 400, { error: 'path is required' })
          return
        }
        const { layout } = await machine.requireProject(input.project)
        const config = runtime.getConfig()
        const result = await trimAudioAsset({
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          layout,
          relativePath: input.path,
          start: typeof input.start === 'number' ? input.start : 0,
          end: typeof input.end === 'number' ? input.end : undefined,
        })
        // The file is shorter now, so the length the manifest records is
        // simply wrong. Correcting it is what makes the panel's on-screen
        // times and the compose plan agree with what is on disk.
        if (result.seconds !== undefined) {
          await machine.reviseAssetDuration(input.project, result.path, result.seconds)
        }
        sendJson(response, 200, result)
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/asset/restore ----------------------------------------
  // Undo every trim on one take at once. There is no per-cut history to step
  // back through — a trim rewrites the file — so the only honest undo is "the
  // take as it was generated", which is what `originals/` holds.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/asset/restore',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const input = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>
        if (typeof input.project !== 'string' || input.project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        if (typeof input.path !== 'string' || input.path === '') {
          sendJson(response, 400, { error: 'path is required' })
          return
        }
        const { layout } = await machine.requireProject(input.project)
        const result = await restoreAudioAsset({
          ffprobePath: runtime.getConfig().ffprobePath,
          layout,
          relativePath: input.path,
        })
        if (result.seconds !== undefined) {
          await machine.reviseAssetDuration(input.project, result.path, result.seconds)
        }
        sendJson(response, 200, result)
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/validate ---------------------------------------------
  // Schema checking without a write, so an editor can mark problems while the
  // user types. The panel must not re-implement these rules: they live in
  // schema.ts, and a browser copy would drift from the one the gate enforces.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/validate',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        const body = await readJsonBody(request)
        const input = (body ?? {}) as Record<string, unknown>
        const artifact = input.artifact
        if (typeof artifact !== 'string' || !ARTIFACTS.includes(artifact as ArtifactName)) {
          sendJson(response, 400, { error: 'artifact must be one of ' + ARTIFACTS.join(', ') })
          return
        }
        const issues = validateArtifact(artifact as ArtifactName, input.value)
        sendJson(response, 200, {
          artifact,
          valid: issues.length === 0,
          issues,
          text: issues.length === 0 ? '' : formatIssues(issues),
        })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST/GET /openreel/compose -------------------------------------------
  //
  // The compose screen renders the film itself rather than asking the agent to.
  // By this point nothing is left to decide: the cut, the pauses, the subtitle
  // style and the music were all settled on the screen, and routing the last
  // step through a model adds a round trip and a chance to mistranscribe them.
  // `openreel_compose` stays for unattended runs, and both go through
  // `composeProject` so the prerequisites and the slideshow refusal cannot hold
  // on one path and be skipped on the other.
  //
  // A render takes minutes, so POST starts one and returns; GET reports where
  // it is. Holding the request open for the whole encode would give the page
  // nothing to show and put the result at the mercy of an idle timeout.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/compose',
    handler: async (request, response) => {
      try {
        const projectId = request.method === 'GET'
          ? (query(request).get('project') ?? '')
          : undefined

        if (request.method === 'GET') {
          if (projectId === '') {
            sendJson(response, 400, { error: 'project is required' })
            return
          }
          const job = renders.get(projectId as string)
          sendJson(response, 200, job === undefined
            ? { running: false, state: 'idle' }
            : {
                running: job.state === 'running',
                state: job.state,
                progress: job.progress,
                fraction: job.fraction,
                phase: job.phase,
                elapsed_seconds: Number(((Date.now() - job.startedAt) / 1000).toFixed(1)),
                ...(job.result === undefined ? {} : { result: job.result }),
                ...(job.error === undefined ? {} : { error: job.error, code: job.code }),
              })
          return
        }

        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'GET or POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const input = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>
        const project = input.project
        if (typeof project !== 'string' || project === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        // One render per project at a time. Two concurrent encodes write the
        // same work directory and the same output file, and the loser would
        // corrupt the winner's film rather than merely wasting a CPU.
        const existing = renders.get(project)
        if (existing?.state === 'running') {
          sendJson(response, 409, { error: '这个项目正在合成中', code: 'ALREADY_RENDERING', progress: existing.progress })
          return
        }
        // Fail fast on a project that is not ready, so the button reports it
        // instead of a job that dies a second later with nobody watching.
        await machine.requireProject(project)

        const background = input.subtitle_background
        const controller = new AbortController()
        const job: RenderJob = {
          state: 'running', progress: '准备中', fraction: 0, phase: 'probing',
          startedAt: Date.now(), controller,
        }
        renders.set(project, job)

        // Deliberately not awaited: the response goes out now and the page
        // polls. Every failure path below lands on the job, which is what the
        // page reads -- an unhandled rejection here would be invisible.
        void (async (): Promise<void> => {
          try {
            const result = await composeProject(runtime, {
              projectId: project,
              ...(typeof input.burn_subtitles === 'boolean' ? { burnSubtitles: input.burn_subtitles } : {}),
              ...(background === 'outline' || background === 'box'
                ? { subtitleBackground: background } : {}),
              ...(input.force === true ? { force: true } : {}),
              ...(typeof input.cut === 'string' && input.cut !== '' ? { cutId: input.cut } : {}),
              signal: controller.signal,
              onProgress: (update) => {
                job.progress = update.label
                job.phase = update.phase
                // Never backwards. A bar that retreats reads as a fault even
                // when the estimate behind it genuinely improved.
                job.fraction = Math.max(job.fraction, update.fraction)
              },
            })
            // Recorded through the state machine, the same call openreel_stage
            // makes. The panel may advance the pipeline; it may not reach past
            // the schema and asset checks while doing it, and writing the
            // checkpoint here directly is exactly the shortcut that would.
            job.progress = '记录成片'
            job.phase = 'recording'
            job.fraction = 1
            await machine.write({
              projectId: project,
              stage: 'compose',
              status: 'completed',
              artifacts: { render_report: result.report as unknown as Record<string, unknown> },
              humanApproved: false,
            })
            job.result = result
            job.state = 'done'
            job.progress = '完成'
            job.phase = 'done'
          } catch (error) {
            job.state = 'failed'
            job.error = errorMessage(error)
            job.code = error instanceof StateViolationError ? error.code : 'RENDER_FAILED'
          }
        })()

        sendJson(response, 202, { started: true, project })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/models -----------------------------------------------
  // A query may use unsaved connection fields, but never writes them or returns a Key.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/models',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'POST only' }); return }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'cross-origin requests are refused' }); return }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(response, 400, { error: 'a JSON object body is required' }); return
        }
        const input = body as Record<string, unknown>
        const kind = input.kind
        if (kind !== 'voice' && kind !== 'image' && kind !== 'video') {
          sendJson(response, 400, { error: 'kind=voice|image|video is required' }); return
        }
        const connection = input.connection !== null && typeof input.connection === 'object' && !Array.isArray(input.connection)
          ? input.connection as Record<string, unknown> : {}
        const saved = runtime.getConfig().generation.api[kind]
        const config: ApiEndpointConfig & Partial<VoiceApiConfig> = { ...saved }
        for (const field of ['endpoint', 'modelsUrl', 'apiKeyEnv'] as const) {
          if (typeof connection[field] === 'string') config[field] = connection[field].trim()
        }
        // The client cannot read the saved secret; blank means use it on the host.
        if (typeof connection.apiKey === 'string' && connection.apiKey.trim() !== '') config.apiKey = connection.apiKey.trim()
        if (kind === 'voice' && (connection.protocol === 'openai' || connection.protocol === 'dashscope')) config.protocol = connection.protocol
        sendJson(response, 200, await discoverApiModels(kind, config))
      } catch (error) { fail(response, error) }
    },
  }))

  // ---- POST /openreel/generate ---------------------------------------------
  // Direct API generation for installations that do not want a ComfyUI round
  // trip. The route writes the same manifests as the Agent path, so the rest
  // of the pipeline and its approval gates remain unchanged.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/generate',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(response, 400, { error: 'a JSON object body is required' })
          return
        }
        const input = body as Record<string, unknown>
        const project = typeof input.project === 'string' ? input.project : ''
        const kind = input.kind
        if (project === '' || (kind !== 'visual' && kind !== 'voice')) {
          sendJson(response, 400, { error: 'project and kind=visual|voice are required' })
          return
        }
        if (!Array.isArray(input.items) || input.items.length === 0) {
          sendJson(response, 400, { error: 'items must be a non-empty array' })
          return
        }
        const config = runtime.getConfig()
        const { layout, marker } = await machine.requireProject(project)
        const script = await machine.readArtifact<Script>(layout, 'script')
        if (script === undefined) {
          sendJson(response, 409, { error: 'script has not been created yet' })
          return
        }
        const sections = new Map(script.sections.map((section) => [section.id, section]))
        const mode = input.mode === 'video' ? 'video' : 'image'
        const outputFrame = resolveVideoProfile(marker.target_platform
          ?? (await machine.readArtifact<{ target_platform?: string }>(layout, 'brief'))?.target_platform,
        config.video.renderScale, config.video.fps)
        let frame = resolveGenerationSize(marker.api_visual_sizes?.[mode], outputFrame)
        if (kind === 'visual' && 'frame' in input) {
          const error = generationSizeError(input.frame)
          if (error !== undefined) { sendJson(response, 400, { error }); return }
          const custom = input.frame as GenerationSize
          frame = { width: custom.width, height: custom.height }
        }
        const { width, height } = frame
        const visualReferences = kind === 'visual'
          ? await checkVisualReferences(layout, mode, marker.api_visual_references?.[mode] ?? { input: 'text', images: [], videos: [] })
          : undefined
        const referencePaths = kind === 'voice' && Array.isArray(input.voice_references)
          ? input.voice_references
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '')
          : []
        if (kind === 'voice') {
          const referencesRoot = resolve(layout.voiceReferencesDir)
          for (const relative of referencePaths) {
            let absolute: string
            try {
              absolute = resolveInProject(layout, relative)
            } catch (error) {
              sendJson(response, 400, { error: 'invalid voice reference path: ' + (error as Error).message })
              return
            }
            if (absolute !== referencesRoot && !absolute.startsWith(referencesRoot + sep)) {
              sendJson(response, 400, { error: 'voice references must be project uploads under assets/references/voice' })
              return
            }
            try {
              if (!(await fs.stat(absolute)).isFile()) throw new Error('not a file')
            } catch {
              sendJson(response, 400, { error: 'voice reference was not found: ' + relative })
              return
            }
          }
        }
        const items: Array<{ sectionId: string; index?: number; text: string; prompt: string; seconds: number }> = []
        for (const raw of input.items) {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            sendJson(response, 400, { error: 'each item must be an object' })
            return
          }
          const item = raw as Record<string, unknown>
          const sectionId = typeof item.section_id === 'string' ? item.section_id.trim() : ''
          if (sectionId === '' || !sections.has(sectionId)) {
            sendJson(response, 400, { error: 'item.section_id must refer to a script section' })
            return
          }
          const index = typeof item.shot_index === 'number' && Number.isInteger(item.shot_index) && item.shot_index >= 0
            ? item.shot_index : undefined
          const text = typeof item.text === 'string' ? item.text.trim() : ''
          const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
          if (kind === 'visual' && prompt === '') {
            sendJson(response, 400, { error: 'visual items require prompt' })
            return
          }
          if (kind === 'voice' && text === '') {
            sendJson(response, 400, { error: 'voice items require text' })
            return
          }
          const seconds = item.seconds ?? marker.api_video_seconds ?? 4
          if (kind === 'visual' && mode === 'video') {
            const error = videoSecondsError(seconds)
            if (error !== undefined) { sendJson(response, 400, { error }); return }
          }
          items.push({
            sectionId,
            ...(index === undefined ? {} : { index }),
            text,
            prompt,
            seconds: typeof seconds === 'number' && seconds > 0 ? seconds : 4,
          })
        }

        const assets: AssetRecord[] = []
        const replaceSections = new Set(items.map((item) => item.sectionId))
        const replaceShots = new Set(items.map((item) => item.sectionId + '#' + (item.index ?? 0)))
        const artifactName = kind === 'voice' ? 'asset_manifest_audio' : 'asset_manifest_shots'
        const stage = kind === 'voice' ? 'assets_audio' : 'assets_shots'
        const existing = await machine.readArtifact<AssetManifest>(layout, artifactName)
        const retained = (existing?.assets ?? []).filter((asset) => {
          if (kind === 'voice') return !replaceSections.has(asset.scene_id)
          return !replaceShots.has(asset.scene_id + '#' + (asset.shot_index ?? 0))
        })

        for (const item of items) {
          try {
            const file = kind === 'voice'
              ? await generateVoice(layout, config.generation, {
                  text: item.text,
                  voice: typeof input.voice === 'string' ? input.voice.trim() : marker.voice,
                  ...(typeof input.language === 'string' ? { language: input.language } : {}),
                  ...(referencePaths.length === 0 ? {} : { referencePaths }),
                })
              : mode === 'video'
                ? await generateVideo(layout, config.generation, {
                    prompt: item.prompt,
                    width,
                    height,
                    seconds: item.seconds,
                    ...(visualReferences === undefined ? {} : { references: visualReferences }),
                  })
                : await generateImage(layout, config.generation, { prompt: item.prompt, width, height, ...(visualReferences === undefined ? {} : { references: visualReferences }) })

            assets.push({
              id: 'api-' + randomUUID(),
              type: kind === 'voice' ? 'narration' : mode,
              path: file.path,
              source_tool: 'model_api',
              scene_id: item.sectionId,
              ...(kind === 'visual' && item.prompt !== '' ? { prompt: item.prompt } : {}),
              ...(item.index === undefined ? {} : { shot_index: item.index }),
              ...(kind === 'visual' ? {
                resolution: width + 'x' + height,
                format: file.format,
                model: (mode === 'video' ? config.generation.api.video : config.generation.api.image).model,
              } : {}),
            })
            const manifest: AssetManifest = { version: '1.0', assets: [...retained, ...assets] }
            await machine.write({
              projectId: project,
              stage,
              status: 'in_progress',
              artifacts: { [artifactName]: manifest },
              humanApproved: false,
              note: '由模型 API 生成并记录',
            })
          } catch (error) {
            if (assets.length > 0) {
              const manifest: AssetManifest = { version: '1.0', assets: [...retained, ...assets] }
              await machine.write({
                projectId: project,
                stage,
                status: 'in_progress',
                artifacts: { [artifactName]: manifest },
                humanApproved: false,
                note: 'API 批次部分完成，生成失败',
              }).catch(() => {})
            }
            throw error
          }
        }

        sendJson(response, 200, {
          accepted: assets.length,
          assets: assets.map((asset) => ({ id: asset.id, path: asset.path, type: asset.type })),
        })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  // ---- POST /openreel/stage ------------------------------------------------
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/openreel/stage',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin writes are refused' })
          return
        }
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object') {
          sendJson(response, 400, { error: 'a JSON object body is required' })
          return
        }
        const input = body as Record<string, unknown>
        const projectId = input.project
        const stage = input.stage
        const status = input.status
        if (typeof projectId !== 'string' || projectId === '') {
          sendJson(response, 400, { error: 'project is required' })
          return
        }
        if (!isStage(stage)) {
          sendJson(response, 400, { error: 'stage must be one of ' + STAGES.join(', ') })
          return
        }
        if (!isStatus(status)) {
          sendJson(response, 400, { error: 'status must be in_progress | awaiting_human | completed | failed' })
          return
        }
        const artifacts = input.artifacts
        const result = await machine.write({
          projectId,
          stage,
          status,
          artifacts: artifacts !== null && typeof artifacts === 'object' && !Array.isArray(artifacts)
            ? structuredClone(artifacts) as Record<string, unknown>
            : {},
          humanApproved: input.human_approved === true,
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
        })
        const after = await machine.status(projectId)
        sendJson(response, 200, {
          stage,
          status,
          human_approved: result.checkpoint.human_approved,
          invalidated: result.invalidated,
          notices: result.notices,
          next_stage: after.next_stage,
          awaiting_approval: after.awaiting_approval,
        })
      } catch (error) {
        fail(response, error)
      }
    },
  }))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
