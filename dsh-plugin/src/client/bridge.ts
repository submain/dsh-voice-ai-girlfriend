/**
 * Bridge HTTP client: talks to the local voice-bridge service
 * (http://127.0.0.1:8765 by default, overridable via localStorage
 * `s2s.voice.bridge`).
 */

const DEFAULT_BRIDGE = 'http://127.0.0.1:8765'

/** Resolve the bridge base URL (localStorage override wins). */
export function bridgeBase(): string {
  try {
    return localStorage.getItem('s2s.voice.bridge')?.trim() || DEFAULT_BRIDGE
  } catch {
    return DEFAULT_BRIDGE
  }
}

/**
 * 语音总开关（composer 上的喇叭按钮，localStorage `s2s.voice.enabled`）。
 *
 * ⚠️ 它是整条回复管道的总闸：关掉时 reply-listener 直接 return，逐句 TTS 与
 * 数字人提交**都不会发生**（数字人本质是「用视频代替朗读」，所以跟着总闸走）。
 * 界面据此给出提示，避免「我开了数字人怎么没反应」。
 */
export function readVoiceEnabled(): boolean {
  try {
    return localStorage.getItem('s2s.voice.enabled') !== '0'
  } catch {
    return true
  }
}

/** Speech to text: raw 16 kHz mono PCM16 -> { text, language }. */
export async function stt(pcm16: ArrayBuffer): Promise<{ text: string; language?: string }> {
  const resp = await fetch(`${bridgeBase()}/api/stt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Max-Audio-Sec': '30',
    },
    body: pcm16,
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`voice bridge /api/stt failed: ${resp.status} ${body}`.trim())
  }
  return resp.json() as Promise<{ text: string; language?: string }>
}

/** Text to speech: { text } -> 16 kHz mono PCM16 WAV bytes. */
export async function tts(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }
  if (signal !== undefined) init.signal = signal
  const resp = await fetch(`${bridgeBase()}/api/tts`, init)
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`voice bridge /api/tts failed: ${resp.status} ${body}`.trim())
  }
  return resp.arrayBuffer()
}

/** Digital-human task state surfaced by the bridge. */
export interface DhStatus {
  enabled: boolean
  state: 'idle' | 'tts' | 'generating' | 'done' | 'error' | 'discarded' | string
  message: string
  progress: number
  video_file: string
  video_url: string
  /** 本回复已产出的小段视频（续接播放列表）。 */
  videos: { video_file: string; video_url: string }[]
  total_segments: number
  done_segments: number
  code: string
  text: string
  pending: number
  updated_at: number
  /** 首段「提交 → 出片」的预计秒数：暖场按它决定铺多长。 */
  est_wait?: number
}

/**
 * Filler ("暖场") audio shipped with a submission: pre-synthesized short
 * utterances in the CURRENT voice. `open` plays the instant a reply is
 * accepted (the digital human takes tens of seconds to produce its first
 * frame, and silence reads as "disconnected"); `mid` fills the gap whenever
 * the playback queue runs dry while more segments are still rendering.
 */
export interface DhWarmupItem {
  /** Spoken filler (always present once synthesized). */
  audio: string
  /** Lip-synced clip rendered offline by DUIX; null until that finishes. */
  video: string | null
  /** Clip length in seconds — used to fill exactly until the real video lands. */
  sec?: number
}

export interface DhWarmup {
  open: DhWarmupItem[]
  mid: DhWarmupItem[]
  max_mid?: number
}

let warmupListener: ((warmup: DhWarmup) => void) | null = null

/**
 * Subscribe to the warmup bundle of every accepted submission. Single
 * consumer by design: the companion window owns audio playback.
 * Returns an unsubscribe function.
 */
export function onDhWarmup(cb: (warmup: DhWarmup) => void): () => void {
  warmupListener = cb
  return () => {
    if (warmupListener === cb) warmupListener = null
  }
}

/** One filler choice made for a user turn (LLM preferred, rule fallback). */
export interface DhWarmupPick {
  ok: boolean
  source: 'llm' | 'rule' | 'empty' | 'off'
  ms: number
  open: DhWarmupItem
  mid: DhWarmupItem[]
  max_mid: number
  /** 首段预计等待（秒）：暖场铺多长按它算。 */
  est_wait: number
}

let pickListener: ((pick: DhWarmupPick) => void) | null = null

/** Subscribe to warmup choices (single consumer: the companion player). */
export function onDhWarmupPick(cb: (pick: DhWarmupPick) => void): () => void {
  pickListener = cb
  return () => {
    if (pickListener === cb) pickListener = null
  }
}

let userSpokeListener: (() => void) | null = null

/**
 * Fired the INSTANT a new user turn appears — BEFORE the picker round-trip.
 * The player uses it to start a filler immediately (with the previous turn's
 * scene and the measured wait estimate), so the gap is filled in ~0 ms instead
 * of waiting for the network. The picker result then only refines the plan.
 */
export function onUserSpoke(cb: () => void): () => void {
  userSpokeListener = cb
  return () => {
    if (userSpokeListener === cb) userSpokeListener = null
  }
}

/** Warmup manifest for the current voice (no LLM involved; cached on the bridge). */
export async function dhWarmupManifest(): Promise<DhWarmup | null> {
  try {
    const resp = await fetch(`${bridgeBase()}/api/dh/warmup`)
    if (!resp.ok) return null
    const json = (await resp.json()) as { open?: DhWarmupItem[]; mid?: DhWarmupItem[]; max_mid?: number }
    if (!json.open || !json.mid || json.open.length === 0) return null
    return { open: json.open, mid: json.mid, max_mid: json.max_mid }
  } catch {
    return null
  }
}

/**
 * Ask the bridge to pick fillers for ONE user turn — fired the moment the user
 * stops talking, IN PARALLEL with the real answer. The request only makes the
 * model emit a few tokens, while the first video segment is ten-plus seconds
 * away, so this latency is free.
 */
export async function dhPickWarmup(text: string): Promise<DhWarmupPick | null> {
  // 先让播放端立刻开口（用上一轮的场景 + 实测等待长度），不等网络
  userSpokeListener?.()
  try {
    const resp = await fetch(`${bridgeBase()}/api/dh/warmup/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!resp.ok) return null
    const json = (await resp.json()) as DhWarmupPick
    if (json.ok !== true) return null
    pickListener?.(json)
    return json
  } catch {
    return null // the caller already has a rule-based fallback on the bridge
  }
}

/**
 * Report the outcome of a filler playback attempt back to the bridge.
 *
 * Browsers reject `play()` on media with sound when the page is not visible /
 * has no user activation — the file still downloads (200/206 in the bridge
 * log) but nothing is heard. Without this report it is impossible to tell
 * "never played" from "played but muted by policy".
 */
export function reportWarmup(result: {
  ok: boolean
  kind: string
  error?: string
  hidden: boolean
}): void {
  void fetch(`${bridgeBase()}/api/dh/warmup/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  }).catch(() => {
    // diagnostics only — never break playback over this
  })
}

/** Result of one /api/dh/speak call (submit or stream append). */
export interface DhSpeakResult {
  ok?: boolean
  code?: string
  /** append 失败原因：'gone' = 原任务已结束（调用方应开新任务）。 */
  reason?: string
  warmup?: DhWarmup
  total_segments?: number
}

/**
 * Digital human: feed reply text to the bridge, which synthesizes it with the
 * same TTS voice and renders a lip-synced talking-head video (DUIX).
 *
 * Two modes:
 * - submit (`append: false`): a new task; the latest submission replaces any
 *   not-yet-started one in the bridge queue.
 * - append (`append: true`, with the task `code`): stream the rest of the
 *   reply into the RUNNING task. This is what removes the perceived gap — the
 *   model is still typing while DUIX already renders the first sentences.
 *
 * `done: true` says "no more text for this reply", letting the bridge finish
 * the task instead of waiting for the next append.
 */
export function dhSpeak(
  text: string,
  opts?: { append?: boolean; done?: boolean; code?: string | null },
): Promise<DhSpeakResult | null> {
  const body = (text || '').trim()
  const append = opts?.append === true
  if (!append && !body) return Promise.resolve(null)
  return fetch(`${bridgeBase()}/api/dh/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: body,
      append,
      done: opts?.done === true,
      code: opts?.code ?? '',
    }),
  })
    .then(async (resp) => {
      if (!resp.ok) {
        const b = await resp.text().catch(() => '')
        throw new Error(`/api/dh/speak failed: ${resp.status} ${b}`.trim())
      }
      const json = (await resp.json()) as DhSpeakResult
      // Hand the filler audio to the player BEFORE returning: the whole point
      // is to be heard immediately, not after the first video segment lands.
      if (json.warmup !== undefined) warmupListener?.(json.warmup)
      return json
    })
    .catch((err) => {
      console.error('[ui-voice] digital human submit failed:', err)
      return null
    })
}

/** Discard a submitted digital-human task (barge-in / new turn): its result
 *  will never be played. Safe to call with null (no-op). */
export function dhDiscard(code: string | null | undefined): void {
  if (!code) return
  void fetch(`${bridgeBase()}/api/dh/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }).catch(err => console.error('[ui-voice] digital human discard failed:', err))
}

/** Poll the digital-human task state (companion window playback driver). */
export async function dhStatus(): Promise<DhStatus | null> {
  try {
    const resp = await fetch(`${bridgeBase()}/api/dh/status`)
    if (!resp.ok) return null
    return resp.json() as Promise<DhStatus>
  } catch {
    return null
  }
}

/**
 * Flip the BRIDGE-side digital-human switch (runtime, persisted in the bridge's
 * bridge-config.json). Turning it off makes the bridge stop for real: no queue
 * worker, no startup warmup, no DUIX submit/probe traffic at all — the TTS path
 * keeps working. Turning it on starts the worker + warmup.
 * Resolves with the bridge's resulting state (null when unreachable).
 */
export async function dhEnable(enabled: boolean): Promise<boolean | null> {
  try {
    const resp = await fetch(`${bridgeBase()}/api/dh/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!resp.ok) return null
    const json = (await resp.json()) as { enabled?: boolean }
    return json.enabled ?? null
  } catch (err) {
    console.error('[ui-voice] digital human switch failed:', err)
    return null
  }
}

/** Window event fired after the local DH toggle changes (or syncs on mount):
 *  listeners re-read the bridge switch so flipping it takes effect immediately. */
export const DH_CHANGE_EVENT = 'dsh-voice:dh-change'

/** Announce a DH toggle change to the rest of the plugin. */
export function notifyDhChanged(): void {
  try {
    window.dispatchEvent(new Event(DH_CHANGE_EVENT))
  } catch {
    // no window (non-browser context) — nothing to notify
  }
}

/**
 * Streaming silero VAD client for barge-in detection (the server-side VAD of
 * the original speech-to-speech project). While a reply is playing the mic
 * recorder pushes PCM16 chunks here; the bridge replies
 * `{ event: 'speech_start' }` only when a REAL human voice is detected — TTS
 * echo / music / ambient noise never trip it.
 */
export class VadStream {
  private ws: WebSocket | null = null
  private buffered: ArrayBuffer[] = []
  private closed = false
  private connected = false

  /** Whether the VAD socket is actually connected. The recorder falls back to
   *  RMS heuristics while this is false (e.g. an old bridge without /api/vad). */
  get available(): boolean {
    return this.connected
  }

  /**
   * @param onSpeechStart - fired once when silero VAD hears speech.
   */
  open(onSpeechStart: () => void): void {
    if (this.ws !== null) return
    this.closed = false
    const proto = bridgeBase().startsWith('https:') ? 'wss:' : 'ws:'
    const url = `${proto}//${bridgeBase().replace(/^https?:\/\//, '')}/api/vad`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.connected = true
      for (const chunk of this.buffered.splice(0)) {
        ws.send(chunk)
      }
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { event?: string }
        if (msg.event === 'speech_start') onSpeechStart()
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.connected = false
    }
  }

  /** Push one 16 kHz PCM16 chunk (no-op while the socket is down). */
  send(pcm16: ArrayBuffer): void {
    const ws = this.ws
    if (ws === null || this.closed) return
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(pcm16)
    } else if (ws.readyState === WebSocket.CONNECTING) {
      this.buffered.push(pcm16)
      if (this.buffered.length > 64) this.buffered.shift()
    }
  }

  close(): void {
    this.closed = true
    this.buffered = []
    const ws = this.ws
    this.ws = null
    if (ws !== null) {
      try { ws.close() } catch { /* already closed */ }
    }
  }
}
