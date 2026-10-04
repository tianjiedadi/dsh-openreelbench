/**
 * The browser half's handle on the `openreel` settings namespace.
 *
 * Everything here is structural. The scope arrives on the client context as
 * `ctx.configForms` — a service, not an import — so this bundle never pulls a
 * platform module in as a value and stays loadable from the plugin table.
 *
 * The host exposes the namespace through the dsh 0.2 settings service; this
 * file is the browser end of that same contract. Neither side knows about the
 * other beyond the namespace string.
 */
import { useSyncExternalStore } from 'react'

/** Must match the namespace the host registers in `src/index.ts`. */
export const OPENREEL_NAMESPACE = 'openreel'

/** Client-side sync state of one settings namespace. */
export interface ScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  /** Schema-resolved section: user layer over composition layer over defaults. */
  value: T | undefined
  /** What a cleared field reverts to. */
  base: unknown
  /** Raw user layer. A field's PRESENCE here is what marks it overridden. */
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

export interface SettingsScope<T> {
  getSnapshot(): ScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  /** Atomic path writes preserve secrets omitted from the wire snapshot. */
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>
  /** Queue one top-level field write. */
  set(field: string, value: unknown): Promise<boolean>
  /** Queue one top-level field clear, re-inheriting the composition layer. */
  unset(field: string): Promise<boolean>
}

export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

export interface ConfigFormsService {
  get<T>(namespace: string): SettingsScope<T>
}

/**
 * The client context this plugin needs. Declared structurally for the same
 * reason the host's ToolDefinition is: the plugin then depends on the shape of
 * the services it uses, not on a pinned package version.
 */
/**
 * The session-scoped conversation service.
 *
 * `send` is the panel's only channel to the model, and it exists only in a
 * session scope — the host throws `conversation.send requires a session scope`
 * from a root context. That constraint is why OpenReel 创意台 is a
 * `conversation.view` and not a `shell.overlay`.
 */
/** One text part of a prompt. Images are not sent from this panel. */
export interface PromptTextPart {
  type: 'text'
  text: string
}

/** The harness's RpcResult shape, narrowed to what the panel checks. */
export type RpcResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }

export interface SessionFace {
  prompt(content: PromptTextPart[], mode: 'queue' | 'steer'): Promise<RpcResult>
}

/**
 * The session registry.
 *
 * The panel reaches a session through `binding(id)?.session` and calls
 * `prompt` directly — the same call `conversation.send` makes internally.
 *
 * Two dead ends led here, both worth remembering. `ctx.conversation.send` on
 * the plugin's own context throws `requires a session scope`, because that
 * context is root-scoped. And `ctx.sessions.scope(id).conversation` throws
 * `cannot get property "conversation" without inject`, because a service read
 * off a derived context is guarded by that context's own inject list, not by
 * the plugin's. `binding` sidesteps both: it hands back a plain face, and
 * `sessions` is a service this plugin does declare.
 */
export interface SessionsService {
  binding(id: string): { session: SessionFace } | undefined
}

export interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: unknown): unknown
  }
  configForms: ConfigFormsService
  sessions: SessionsService
}

/**
 * Subscribe a component to a scope. `getSnapshot` returns a stable reference
 * until the next change, which is exactly `useSyncExternalStore`'s contract —
 * so no memoisation or equality check is needed here.
 */
export function useScope<T>(scope: SettingsScope<T>): ScopeSnapshot<T> {
  return useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
}
