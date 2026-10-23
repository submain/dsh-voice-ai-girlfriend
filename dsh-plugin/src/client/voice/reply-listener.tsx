/**
 * ReplySpeakerMount: hidden per-session component (renders null) that streams
 * assistant text to TTS sentence-by-sentence — mirroring the original
 * backend's LMOutputProcessor (per-sentence chunks) so long replies start
 * speaking while the rest are still being synthesized.
 *
 * Each assistant chat node's text is split into complete sentences; as new
 * complete sentences appear (the node streams via `assistant/chunk`
 * publications), they are fetched from the bridge /api/tts through a serial
 * chain and played back in order through the shared ReplySpeaker's FIFO
 * queue. The trailing partial sentence is not spoken until it completes.
 *
 * History replay protection: nodes are seeded on first sight (their current
 * complete sentences are marked spoken), so existing/old content never
 * replays. Barge-in (mic start) swallows the rest of the current reply.
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-chat's `useChat` into SessionStandardProps (0.1.3).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AssistantChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import { tts, dhSpeak, dhStatus, dhDiscard, dhPickWarmup, DH_CHANGE_EVENT } from '../bridge.ts'
import { readDigitalHuman } from '../DigitalHumanToggle.tsx'
import type { VoiceInjected } from '../contract.ts'
import { cleanReplyText } from './clean.ts'
import { splitSentences } from './sentences.ts'
import { chatNodes } from './chat-nodes.ts'

const VOICE_ENABLED_KEY = 's2s.voice.enabled'

function voiceEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

/** Companion window visibility (digital-human video only matters when it shows). */
function companionVisible(): boolean {
  try {
    return localStorage.getItem('s2s.voice.companion') !== '0'
  } catch {
    return true
  }
}

/** Read the assistant row payload off a chat view node (kind `assistant-step`). */
function assistantData(node: { kind: string; data: unknown }): AssistantChatData | undefined {
  if (node.kind !== 'assistant-step') return undefined
  return node.data as AssistantChatData
}

/** Join the node's text blocks (reasoning/tool-call/image excluded). */
function nodeText(data: AssistantChatData): string {
  return data.blocks
    .filter(block => block.kind === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Best-effort text of a user node. Only used to brief the filler picker
 * ("what did the user just say?"), so any shape surprise degrades to '' and
 * the bridge falls back to keyword rules.
 */
function userNodeText(node: { data: unknown }): string {
  const data = node.data as
    | { text?: unknown; blocks?: Array<{ kind?: string; text?: unknown }> }
    | undefined
  if (typeof data?.text === 'string') return data.text
  const blocks = data?.blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block.kind === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join(' ')
}

/** Full props: framework runtime share + `voice` locale seat + injected face. */
export type ReplySpeakerMountProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/**
 * @param props - framework runtime + locale + injected speaker/abort face.
 */
export const ReplySpeakerMount = memo(function ReplySpeakerMount({
  useSession,
  useChat,
  speaker,
  _registerTtsAbort,
  _registerInterruptHandler,
}: ReplySpeakerMountProps) {
  // 0.1.3: chat nodes live on the `useChat` view snapshot (subscribing to it
  // activates the chat target and materializes the nodes). Read them via the
  // chatNodes helper; the rc.8 `snapshot.chat.nodes` map is gone.
  const chat = useChat((s: never) => s)
  const snapshot = useSession(s => s)

  // Per-node complete sentences already spoken (node.key -> count).
  const spokenRef = useRef(new Map<string, number>())
  // History replay protection: baseline anchor. On mount the conversation
  // snapshot can be EMPTY (session history loads asynchronously after a
  // restart), so a one-shot seed there would miss the history and every old
  // reply would replay. Instead we wait until the first SETTLED assistant
  // node arrives, then set the baseline to the current max anchor — nothing
  // at or below it ever speaks. Live (running) nodes are never used for the
  // baseline, so a fresh reply in a brand-new session still speaks.
  const baselineRef = useRef<number | null>(null)
  // Serial TTS fetch chain: sentence N+1's fetch starts after N's resolves
  // (playback drains independently through the speaker queue — pipelined).
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  // Barge-in: swallow the CURRENT reply only. We record the exact anchor of
  // the reply being interrupted (never a "<= max" line): if the interrupt
  // flag is consumed after a NEW reply already appeared in the snapshot, a
  // range-based skip would swallow that fresh reply too — the "new reply
  // never speaks" bug. Exact-anchor skip lets later replies play normally.
  const interruptRef = useRef(false)
  const skipAnchorRef = useRef(0)
  const skipUntilRef = useRef(0)
  // Digital-human streaming feed: per node, the number of COMPLETE sentences
  // already handed to the bridge (node.key -> count). Sentences are the unit
  // because a half-sentence must never be rendered (the video would stop
  // mid-word and the rest could not be appended in sync).
  const dhSentRef = useRef(new Map<string, number>())
  // Serial feed chain: appends for one reply MUST arrive at the bridge in text
  // order, and the first one carries no code yet — chaining keeps that simple.
  const dhFeedRef = useRef<Promise<void>>(Promise.resolve())
  // Highest assistant anchor whose turn was already closed with `done: true`,
  // so the bridge knows no more text is coming (it can finish the task).
  const dhDoneAnchorRef = useRef(0)
  // 桥接侧数字人开关（null = 尚未确认）。它现在**可以热切**：本地开关一翻，
  // 插件会 POST /api/dh/enable，桥接状态变化后广播 DH_CHANGE_EVENT，这里重新
  // 拉取——所以不能再像以前那样只在挂载时解析一次（关掉就再也回不来）。
  // 确认前既不朗读也不提交视频，避免「同一回复先逐句 TTS、又被生成视频」双重播放。
  const [bridgeDh, setBridgeDh] = useState<boolean | null>(null)
  // Code of the most recently submitted digital-human task (for discard).
  const lastDhCodeRef = useRef<string | null>(null)
  // Anchor of the last DH-submitted reply node; a later user node means the
  // pending video is stale and should be discarded.
  const lastDhReplyAnchorRef = useRef(0)
  // Highest user-node anchor seen (new-turn detection).
  const lastUserAnchorRef = useRef(0)

  // Register the barge-in handler once (the mic calls interruptReply).
  useEffect(() => {
    _registerInterruptHandler(() => {
      interruptRef.current = true
    })
    return () => _registerInterruptHandler(null)
  }, [_registerInterruptHandler])

  // Unmount: stop playback and release any in-flight TTS.
  useEffect(() => () => {
    speaker.stop()
    _registerTtsAbort(null)
  }, [speaker, _registerTtsAbort])

  // Track the BRIDGE-side digital-human switch (it can change at runtime): poll
  // it on mount, and re-read it whenever the local toggle announces a change
  // (the plugin POSTs /api/dh/enable first, so the bridge is already updated by
  // the time we look). Bridge unreachable -> false, i.e. replies still speak
  // through sentence TTS.
  useEffect(() => {
    let cancelled = false
    const check = (): void => {
      void dhStatus()
        .then((s) => { if (!cancelled) setBridgeDh(s?.enabled === true) })
        .catch(() => { if (!cancelled) setBridgeDh(false) })
    }
    check()
    const onChange = (): void => { window.setTimeout(check, 200) }
    window.addEventListener(DH_CHANGE_EVENT, onChange)
    return () => {
      cancelled = true
      window.removeEventListener(DH_CHANGE_EVENT, onChange)
    }
  }, [])

  // Stream new complete sentences to TTS on every snapshot change. In digital
  // human mode the reply is NOT spoken immediately — its full text goes to the
  // bridge, which renders a lip-synced video (with the TTS audio embedded);
  // the companion window plays video + sound together once it is ready.
  useEffect(() => {
    if (!voiceEnabled()) return

    // 桥接开关尚未确认：先不朗读也不提交视频，等 dhStatus 返回（桥接不可达时
    // 按非 DH 处理，回复仍会 TTS 朗读）。确认后 setBridgeDh 触发重渲染，等待
    // 窗口期到达的回复会按正确的 dhMode 处理。
    if (bridgeDh === null) return
    const dhMode = bridgeDh && companionVisible() && readDigitalHuman()

    // Barge-in swallowed the CURRENT reply: remember its exact anchor so only
    // that reply's remaining sentences are skipped; replies that appear
    // later (or that already appeared) still speak. In DH mode, discard the
    // pending video task (the reply is being talked over).
    if (interruptRef.current) {
      if (dhMode) {
        dhDiscard(lastDhCodeRef.current)
        lastDhCodeRef.current = null
      }
      let maxAnchor = 0
      for (const node of chatNodes(chat)) {
        if (node.kind === 'assistant-step' && node.anchorSeq > maxAnchor) maxAnchor = node.anchorSeq
      }
      if (maxAnchor > 0) skipAnchorRef.current = maxAnchor
      interruptRef.current = false
      return
    }

    // First settled assistant node arrives: freeze the history baseline so
    // pre-existing replies never replay (page load, session revisit, history
    // pagination). Running nodes are live replies — they are NOT used here,
    // so a fresh reply in a new session still speaks.
    if (baselineRef.current === null) {
      let maxAnchor = 0
      let hasSettled = false
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'assistant-step') continue
        const data = assistantData(node)
        if (data === undefined) continue
        if (data.status === 'settled') hasSettled = true
        if (node.anchorSeq > maxAnchor) maxAnchor = node.anchorSeq
      }
      if (hasSettled && maxAnchor > 0) {
        baselineRef.current = maxAnchor
        skipUntilRef.current = maxAnchor
      }
      return
    }

    if (dhMode) {
      // First sight of the conversation: align the user watermark with what is
      // already there, so loading history never fires a filler request.
      if (lastUserAnchorRef.current === 0) {
        for (const node of chatNodes(chat)) {
          if (node.kind === 'user' && node.anchorSeq > lastUserAnchorRef.current) {
            lastUserAnchorRef.current = node.anchorSeq
          }
        }
      }
      // New user turn: whatever video is still rendering belongs to the
      // previous answer — drop it AND forget its code, so this turn's streamed
      // appends create a fresh task instead of feeding a discarded one.
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'user') continue
        if (node.anchorSeq <= lastUserAnchorRef.current) continue
        const hadPreviousTurn = lastUserAnchorRef.current > 0
        lastUserAnchorRef.current = node.anchorSeq
        if (hadPreviousTurn && lastDhCodeRef.current !== null) {
          dhDiscard(lastDhCodeRef.current)
          lastDhCodeRef.current = null
        }
        // 用户刚说完 → 立刻并行挑暖场（与真正的问答互不阻塞）。这一句是
        // 唯一能在「首段视频还要十几秒」期间给出即时反馈的东西。
        const said = userNodeText(node)
        if (said !== '') void dhPickWarmup(said)
      }

      // ── 流式喂料（2026-10-23）────────────────────────────────────────────
      // 以前必须等整条回复 settled 才 dhSpeak：用户说完 → 等 LLM 吐完（实测
      // 1000 字 37s）→ 再等首段 10~15s，这几十秒全靠暖场「嗯…」顶着，一听
      // 就是卡。现在按句把「已完成的文本」追加进同一个 DUIX 任务：LLM 还在
      // 吐字，DUIX 已经在渲染前面几句，两段时间完全重叠。
      // 单位是**完整句子**（splitSentences）：半句绝不能提交，否则视频会在
      // 词中间断掉，后面的文本也没法接着排下去。
      const feedDh = (text: string, done: boolean): void => {
        dhFeedRef.current = dhFeedRef.current
          .then(() => {
            const code = lastDhCodeRef.current
            return dhSpeak(text, code === null ? { done } : { append: true, done, code })
          })
          .then((res) => {
            if (res === null) return
            if (res.reason === 'gone') {
              // 桥接侧那个任务已经收尾了（空闲超时）：下一句重新开一个任务，
              // 文本顺序依然正确——前面那些句子早就播完了。
              lastDhCodeRef.current = null
              return
            }
            if (typeof res.code === 'string' && res.code !== '') {
              lastDhCodeRef.current = res.code
            }
          })
      }

      const userAnchors: number[] = []
      for (const node of chatNodes(chat)) {
        if (node.kind === 'user') userAnchors.push(node.anchorSeq)
      }
      userAnchors.sort((a, b) => a - b)
      type TurnStep = { node: { key: string; anchorSeq: number }; data: AssistantChatData; anchor: number }
      const perUserTurn = new Map<number, TurnStep[]>()
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'assistant-step') continue
        const data = assistantData(node)
        if (data === undefined || data.status === 'interrupted') continue
        const base = baselineRef.current
        if (base !== null && node.anchorSeq <= base) continue
        if (node.anchorSeq === skipAnchorRef.current) continue
        if (cleanReplyText(nodeText(data), 100000).trim().length < 2) continue
        // The user turn this reply belongs to = nearest preceding user anchor.
        let ua = -1
        for (const u of userAnchors) {
          if (u < node.anchorSeq) ua = u
          else break
        }
        const list = perUserTurn.get(ua) ?? []
        list.push({ node, data, anchor: node.anchorSeq })
        perUserTurn.set(ua, list)
      }
      // 一轮回复 = 一个 DUIX 任务：步内已完成的句子按顺序追加，整轮吐完才
      // 发 done（桥接据此收尾，否则它会一直空等下一批文本）。
      for (const [, steps] of perUserTurn) {
        steps.sort((a, b) => a.anchor - b.anchor)
        let lastAnchor = 0
        let allSettled = true
        for (const step of steps) {
          lastAnchor = Math.max(lastAnchor, step.anchor)
          if (step.data.status !== 'settled') allSettled = false
          const { sentences, partial } = splitSentences(cleanReplyText(nodeText(step.data), 100000))
          const ready = step.data.status === 'settled' && partial !== null
            ? [...sentences, partial]
            : sentences
          const sent = dhSentRef.current.get(step.node.key) ?? 0
          if (ready.length <= sent) continue
          dhSentRef.current.set(step.node.key, ready.length)
          const fresh = ready.slice(sent).join('').trim()
          if (fresh === '') continue
          lastDhReplyAnchorRef.current = Math.max(lastDhReplyAnchorRef.current, step.anchor)
          feedDh(fresh, false)
        }
        if (allSettled && lastAnchor > 0 && dhDoneAnchorRef.current < lastAnchor) {
          dhDoneAnchorRef.current = lastAnchor
          feedDh('', true)
        }
      }
      return
    }

    // Non-DH mode: collect the complete sentences that are new (beyond each
    // node's spoken count), in (anchor, index) order. A SETTLED node also
    // flushes its trailing partial (the reply ended without a terminal
    // punctuation, like a credit line); running nodes wait for the partial.
    const jobs: { anchor: number; key: string; index: number; sentence: string }[] = []
    for (const node of chatNodes(chat)) {
      if (node.kind !== 'assistant-step') continue
      if (node.anchorSeq <= skipUntilRef.current) continue
      if (node.anchorSeq === skipAnchorRef.current) continue
      const data = assistantData(node)
      if (data === undefined || data.status === 'interrupted') continue
      const { sentences, partial } = splitSentences(cleanReplyText(nodeText(data), 100000))
      const speakable = data.status === 'settled' && partial !== null
        ? [...sentences, partial]
        : sentences
      const spoken = spokenRef.current.get(node.key) ?? 0
      if (speakable.length > spoken) {
        for (let i = spoken; i < speakable.length; i++) {
          jobs.push({ anchor: node.anchorSeq, key: node.key, index: i, sentence: speakable[i]! })
        }
        spokenRef.current.set(node.key, speakable.length)
      }
    }
    if (jobs.length === 0) return
    jobs.sort((a, b) => (a.anchor - b.anchor) || (a.index - b.index))

    // Chain the fetches serially (order preserved; playback pipelines via the
    // speaker queue). Each step re-checks voice/interrupt so an abort stops
    // the rest of the chain.
    chainRef.current = jobs.reduce(
      (chain, job) => chain.then(() => {
        if (interruptRef.current || !voiceEnabled()) return
        const controller = new AbortController()
        _registerTtsAbort(controller)
        return tts(job.sentence, controller.signal)
          .then((wav) => {
            if (interruptRef.current || !voiceEnabled()) return
            speaker.speak(wav)
          })
          .catch((err) => {
            if ((err as Error | undefined)?.name !== 'AbortError') {
              console.error('[ui-voice] reply TTS failed:', err)
            }
          })
          .finally(() => _registerTtsAbort(null))
      }),
      chainRef.current,
    )
  }, [chat, speaker, _registerTtsAbort, bridgeDh])

  return null
})
