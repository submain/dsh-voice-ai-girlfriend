/**
 * ThinkingToggle: composer tool-row switch for the model's reasoning mode.
 *
 * Qwen3 这类模型默认会先输出一段推理再作答。对语音对话来说这段推理不但拖慢
 * 首字延迟（实测同一请求 1.2s → 0.1s），还会被写进正文、被 TTS 念出来。所以
 * 默认关闭，需要更缜密的回答时再手动打开。
 *
 * Persists `s2s.voice.thinking` ('1'/'0', default off — matches the provider's
 * `reasoning: off` default in settings.yaml). The switch drives a Session-level
 * model selection (`reasoningEffort: 'off' | 'medium'`), because the effort is a
 * property of the model route, not of a single prompt.
 */
import { memo, useCallback, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VoiceInjected } from './contract.ts'
import { chipStyle, chipKey } from './chip.ts'
import chips from './chips.css'

const THINKING_KEY = 's2s.voice.thinking'

function readThinking(): boolean {
  try {
    // 默认关：provider 侧 settings.yaml 已经 `reasoning: off`，UI 初始态要与之一致。
    return localStorage.getItem(THINKING_KEY) === '1'
  } catch {
    return false
  }
}

/** Sparkle glyph (inline, follows currentColor). */
function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
    </svg>
  )
}

/** Full toggle props: framework runtime share + `voice` locale seat + injected face. */
export type ThinkingToggleProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/**
 * @param props - framework runtime + locale + injected setThinking.
 */
export const ThinkingToggle = memo(function ThinkingToggle({ t, setThinking }: ThinkingToggleProps) {
  const [on, setOn] = useState<boolean>(readThinking)
  const [busy, setBusy] = useState<boolean>(false)

  const toggle = useCallback(() => {
    if (busy) return
    const next = !on
    setBusy(true)
    void setThinking(next)
      .then(() => {
        setOn(next)
        try {
          localStorage.setItem(THINKING_KEY, next ? '1' : '0')
        } catch {
          // persistence unavailable — state still flips for this session
        }
      })
      .catch((err: unknown) => {
        console.error('[ui-voice] thinking toggle failed:', err)
      })
      .finally(() => setBusy(false))
  }, [busy, on, setThinking])

  const hint = on ? t('thinking.onHint') : t('thinking.offHint')

  return (
    <span
      role="button"
      tabIndex={0}
      className={[chips.chip, on ? chips.on : ''].join(' ')}
      title={hint}
      aria-label={hint}
      aria-pressed={on}
      style={{ ...chipStyle(on), opacity: busy ? 0.55 : 1 }}
      onClick={toggle}
      onKeyDown={chipKey}
    >
      <SparkleIcon />
    </span>
  )
})
