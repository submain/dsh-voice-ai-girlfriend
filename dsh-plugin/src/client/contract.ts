/**
 * ui-voice slot contract: the registrant-side props composition for the
 * conversation-owned `conversation.input.left` slot, plus the injected face
 * the plugin apply provides (sendText bound to the session-scoped
 * conversation service).
 */

import type { CompanionController } from './voice/companion-controller.ts'
import type { ReplySpeaker } from './voice/speaker.ts'

/** Injected behavior face the voice components receive from the plugin apply. */
export interface VoiceInjected {
  /**
   * Send a recognized utterance into the current session as a user prompt
   * (equivalent to typing it). Rejects when no session scope or the
   * conversation service is unavailable.
   * @param text - recognized utterance text.
   */
  sendText: (text: string) => Promise<void>
  /** Plays synthesized reply audio; one shared instance per plugin fiber. */
  speaker: ReplySpeaker
  /** Shared companion-window visibility (rendered by the window, flipped by the toggle). */
  companion: CompanionController
  /**
   * Abort any TTS request currently in flight (the reply listener registers
   * its AbortController here; the voice toggle calls this when turned off so
   * the backend stops synthesizing instead of draining its queue).
   */
  abortTts: () => void
  /**
   * Internal wiring (plugin-private): the reply listener registers its
   * current TTS AbortController so `abortTts()` can cancel it.
   */
  _registerTtsAbort: (controller: AbortController | null) => void
  /**
   * Mic barge-in: stop playback, abort the in-flight TTS request, and ask the
   * reply listener to swallow the rest of the current reply (its remaining
   * sentences are not spoken; the next reply speaks normally).
   */
  interruptReply: () => void
  /**
   * Internal wiring (plugin-private): the reply listener registers a handler
   * invoked by `interruptReply()` to mark its current reply as interrupted.
   */
  _registerInterruptHandler: (handler: (() => void) | null) => void
  /**
   * 切换模型的思考模式。
   *
   * 关闭走 Session 级模型选择：`reasoningEffort: 'off'` 会让 provider 的
   * `chatTemplateKwargs` 把 `enable_thinking` 置为 false（见 settings.yaml 的
   * compat 段）。对 Qwen3 这类默认思考的模型，实测同一请求 1.2s → 0.1s，而且
   * 不会再出现「思考过程直接写进正文、被 TTS 念出来」的问题。
   * @param enabled - true 恢复思考（更缜密但更慢），false 关闭思考（首字更快）。
   * @returns 切换完成后 resolve；无 session 或模型不支持档位时 reject。
   */
  setThinking: (enabled: boolean) => Promise<void>
}
