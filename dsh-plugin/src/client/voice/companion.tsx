/**
 * CompanionWindow: the AI-girlfriend's live panel, shown as a small standalone
 * framed card. It is freely DRAGGABLE (drag anywhere on the card to reposition;
 * double-click resets to the default right-center spot) and resizable via the
 * bottom-right corner handle. Position + width persist in localStorage.
 *
 * Inside it the same hf-realtime-voice video pipeline runs:
 *  - Background: two stacked <video> layers crossfade (0.8s) through the
 *    `bg-images` videos (advance on `ended`, plus one hop per assistant reply);
 *    static-image fallback when the folder has no video.
 *  - Foreground: while the ReplySpeaker plays, a framed `task-videos` clip
 *    crossfades in over the background and loops; the digital-human video (has
 *    audio) overlays it when rendering.
 *
 * Robustness:
 *  - The card is ALWAYS mounted (videos never unmount). When the companion is
 *    toggled off, or there is no media / no digital-human task, it is hidden
 *    with inline `display:none` instead of `return null` (returning null would
 *    unmount the <video>s, and on re-mount the background is not re-wired).
 *  - Video visibility is driven by inline `style.opacity`, not a hashed class.
 *  - On any media-list change (idle/persona switch) the background resets and
 *    shows the new idle group immediately.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bridgeBase, dhStatus, dhDiscard, onDhWarmup, tts, readVoiceEnabled, type DhStatus, type DhWarmup } from '../bridge.ts'
import { readDigitalHuman } from '../DigitalHumanToggle.tsx'
import type { VoiceInjected } from '../contract.ts'
import css from './CompanionWindow.module.css'

const WIDTH_KEY = 's2s.voice.companionW'
const POS_KEY = 's2s.voice.companionPos'

const MIN_WIDTH = 180
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 260

function readWidth(): number {
  try {
    const value = Number.parseFloat(localStorage.getItem(WIDTH_KEY) ?? '')
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return value
  } catch {
    // fall through to default
  }
  return DEFAULT_WIDTH
}

/** Load a previously dragged position, or null if the user never moved it. */
function readPos(): { x: number; y: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { x?: number; y?: number } | null
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return { x: Math.round(value.x as number), y: Math.round(value.y as number) }
    }
  } catch {
    // ignore malformed / absent
  }
  return null
}

/** Default spot: right side, vertically centered, with a small viewport margin. */
function defaultPos(w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(12, window.innerWidth - w - 12),
    y: Math.max(12, Math.round((window.innerHeight - h) / 2)),
  }
}

/** The right-fixed sidebar's panel element (better-sidebar & alike), excluding the bottom panel. */
const SIDEBAR_PANEL_SEL = '[data-dsh-panel]:not([data-dsh-bottom-panel])'

/**
 * 右侧固定插件（dsh-better-sidebar 等）展开时占用的右侧宽度（px）。
 * 卡片据此避让到插件左缘，而不是被遮挡。
 */
function useSidebarInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const measure = () => {
      if (document.body.hasAttribute('data-dsh-sidebar-collapsed')) {
        setInset(0)
        return
      }
      const panel = document.querySelector<HTMLElement>(SIDEBAR_PANEL_SEL)
      if (!panel) {
        setInset(0)
        return
      }
      const rect = panel.getBoundingClientRect()
      const w = window.innerWidth
      if (rect.left > 0 && rect.left < w && rect.right >= w - 1) {
        setInset(Math.round(w - rect.left))
      } else {
        setInset(0)
      }
    }
    measure()
    const mo = new MutationObserver(measure)
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-dsh-sidebar-collapsed', 'data-dsh-sidebar-dragging'] })
    let ro: ResizeObserver | null = null
    const bind = () => {
      ro?.disconnect()
      const panel = document.querySelector<HTMLElement>(SIDEBAR_PANEL_SEL)
      if (panel) {
        ro = new ResizeObserver(measure)
        ro.observe(panel)
      }
    }
    bind()
    const iv = window.setInterval(() => {
      if (document.querySelector(SIDEBAR_PANEL_SEL) && ro === null) bind()
    }, 2000)
    return () => {
      mo.disconnect()
      ro?.disconnect()
      window.clearInterval(iv)
    }
  }, [])
  return inset
}

/** A `bg-images` entry in the bridge media list. */
interface BgMedia {
  name: string
  type: 'image' | 'video' | string
}

/** Full props: framework runtime share + `voice` locale seat + injected face. */
export type CompanionWindowProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/** Inline base for every video layer: absolute, fill the card, crossfade via opacity. */
const VIDEO_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  transition: 'opacity 0.8s ease',
  opacity: 0,
}

/** The filler <audio> is audio-only: keep it out of the layout entirely. */
const WARMUP_AUDIO_STYLE: CSSProperties = { display: 'none' }

/** 卡片左下角的异常提示浮层（只在生成失败/取消时出现）。 */
const DH_SEG_STYLE: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 132,
  maxWidth: '62%',
  padding: '7px 11px',
  borderRadius: 12,
  background: 'rgba(10,11,16,0.74)',
  color: 'rgba(255,255,255,0.9)',
  fontSize: 12,
  lineHeight: 1.2,
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  zIndex: 6,
  backdropFilter: 'blur(6px)',
}

/** 语音总开关关着时的提示（整条回复管道的总闸，数字人也跟着不提交）。 */
const DH_HINT_STYLE: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
  maxWidth: '62%',
  padding: '7px 11px',
  borderRadius: 12,
  background: 'rgba(120,72,8,0.82)',
  color: '#fde68a',
  fontSize: 12,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  pointerEvents: 'none',
  zIndex: 7,
  backdropFilter: 'blur(6px)',
}

/**
 * 数字人异常时的一行提示。正常生成/播放期间不再显示任何文字（原先的
 * 「数字人 · 第 N/M 段 生成中」这类分段进度已按需求去掉，窗口只留画面）。
 */
function dhSegText(dh: DhStatus): string {
  if (dh.state === 'error') return `数字人 · 失败：${dh.message || '生成出错'}`
  if (dh.state === 'discarded') return '数字人 · 已取消'
  return ''
}

/**
 * @param props - framework runtime + locale + injected speaker face.
 */
export const CompanionWindow = memo(function CompanionWindow({ speaker, companion }: CompanionWindowProps) {
  const [visible, setVisible] = useState<boolean>(companion.visible)
  const [widthPx, setWidthPx] = useState<number>(readWidth)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(readPos)
  const [speaking, setSpeaking] = useState<boolean>(speaker.speaking)

  // Background media list (from bg-images) + the task-video list (task-videos).
  const [bgMedia, setBgMedia] = useState<BgMedia[]>([])
  const [taskVideos, setTaskVideos] = useState<string[]>([])
  const [bgImageUrl, setBgImageUrl] = useState('')

  // Digital human: bridge task state + the video currently being played.
  const [dh, setDh] = useState<DhStatus | null>(null)
  const [dhPlaying, setDhPlaying] = useState(false)
  const dhPlayingRef = useRef(false)
  const setDhPlayingBoth = useCallback((v: boolean) => {
    dhPlayingRef.current = v
    setDhPlaying(v)
  }, [])

  // Background crossfade layers.
  const bgA = useRef<HTMLVideoElement | null>(null)
  const bgB = useRef<HTMLVideoElement | null>(null)
  const bgActive = useRef(true)
  const bgTransitioning = useRef(false)
  const bgWired = useRef(false)
  const bgIndexRef = useRef(-1)
  const bgMediaRef = useRef<BgMedia[]>([])

  // Foreground task/avatar frame.
  const taskRef = useRef<HTMLVideoElement | null>(null)
  const taskIndexRef = useRef(-1)
  const taskPlayingRef = useRef(false)
  const taskPendingStopRef = useRef(false)
  const wasSpeakingRef = useRef(false)

  // Digital-human frame.
  const dhRef = useRef<HTMLVideoElement | null>(null)
  const handledDhRef = useRef(new Set<string>())
  const waitingDhRef = useRef<{ code: string; at: number } | null>(null)
  const dhQueueRef = useRef<string[]>([])
  const dhQueueCodeRef = useRef('')
  const dhQueuePlayedRef = useRef(0)
  // 桥接仍在分段生成（还有后续段没到）→ 播放端播空时「停在最后一帧」，
  // 而不是掉回待机动画（首段为了尽快出帧被切短，生成端追不上时就会播空）。
  const dhPendingRef = useRef(false)
  const dhHoldingRef = useRef(false)

  // Filler ("暖场") audio: pre-synthesized "嗯…" clips in the current voice.
  // open = the instant a reply is accepted (first frame is ~10s+ away);
  // mid  = when the segment queue runs dry while more is still rendering.
  const warmVidRef = useRef<HTMLVideoElement | null>(null)
  const warmRef = useRef<HTMLAudioElement | null>(null)
  const warmupRef = useRef<DhWarmup | null>(null)
  const warmMidCountRef = useRef(0)
  const warmMidAtRef = useRef(0)
  const warmLastOpenRef = useRef(0)

  // Drag-move state.
  const moveRef = useRef<{ startX: number; startY: number; base: { x: number; y: number } } | null>(null)
  const posRef = useRef<{ x: number; y: number } | null>(pos)
  const dragRef = useRef<{ startX: number; startWidth: number; current: number } | null>(null)

  // Portrait framing: height scales with width (capped to the viewport).
  const heightPx = Math.round(Math.min(Math.max(widthPx * 1.5, 260), Math.min(560, window.innerHeight * 0.7)))

  // ── Background crossfade (ported from hf-realtime-voice main.js) ──────────
  const showBgMedia = useCallback((index: number) => {
    const list = bgMediaRef.current
    const entry = list[index]
    if (!entry) return
    const a = bgA.current
    const b = bgB.current
    if (!a || !b) return
    const src = `${bridgeBase()}/media/bg-images/${encodeURIComponent(entry.name)}`
    if (entry.type === 'video') {
      setBgImageUrl('')
      if (!bgWired.current) {
        // First ever background: show it without a crossfade.
        bgWired.current = true
        const vid = bgActive.current ? a : b
        vid.src = src
        vid.style.opacity = '1'
        vid.load()
        void vid.play().catch(() => {})
        return
      }
      // Cross-fade into the spare layer once it can play (avoids a black frame).
      const from = bgActive.current ? a : b
      const to = bgActive.current ? b : a
      bgTransitioning.current = true
      to.src = src
      to.load()
      const startFade = () => {
        to.removeEventListener('canplay', startFade)
        bgActive.current = !bgActive.current
        from.style.opacity = '0'
        to.style.opacity = '1'
        void to.play().catch(() => {})
        // Release the now-hidden layer's decoder so only ONE video decodes at a
        // time (two full-res streams playing concurrently caused page lag).
        window.setTimeout(() => { bgTransitioning.current = false; from.pause() }, 900)
      }
      to.addEventListener('canplay', startFade)
      window.setTimeout(() => { if (bgTransitioning.current) startFade() }, 3000)
      return
    }
    // Image fallback: hide the video layers, show a static background image.
    a.style.opacity = '0'
    b.style.opacity = '0'
    a.pause()
    b.pause()
    bgActive.current = true
    setBgImageUrl(`url("${src}")`)
  }, [])

  const advanceBgVideo = useCallback((): number => {
    const list = bgMediaRef.current
    if (list.length < 2) return -1
    let next = bgIndexRef.current
    for (let step = 0; step < list.length; step++) {
      next = (next + 1) % list.length
      if (list[next].type === 'video') {
        bgIndexRef.current = next
        showBgMedia(next)
        return next
      }
    }
    return -1
  }, [showBgMedia])

  const onBgVideoEnded = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (bgTransitioning.current) return
    const visibleEl = bgActive.current ? bgA.current : bgB.current
    if (event.currentTarget !== visibleEl) return
    advanceBgVideo()
  }, [advanceBgVideo])

  /** Advance the background one video per assistant reply. */
  const rotateBgReply = useCallback(() => {
    const list = bgMediaRef.current
    if (list.some(m => m.type === 'video')) {
      advanceBgVideo()
      return
    }
    if (list.length < 2) return
    bgIndexRef.current = (bgIndexRef.current + 1) % list.length
    showBgMedia(bgIndexRef.current)
  }, [advanceBgVideo, showBgMedia])

  /** Show the FIRST media of the CURRENT list (used on load and on any media list
   *  change, e.g. an idle/persona switch) so the new idle group appears at once. */
  const resetBg = useCallback(() => {
    bgWired.current = false
    bgActive.current = true
    bgTransitioning.current = false
    bgIndexRef.current = 0
    const a = bgA.current
    const b = bgB.current
    if (a) {
      a.pause()
      a.style.opacity = '0'
    }
    if (b) {
      b.pause()
      b.style.opacity = '0'
    }
    if (bgMediaRef.current.length > 0) showBgMedia(0)
  }, [showBgMedia])

  // Load media lists from the bridge on mount, then re-poll every 30 s. Only
  // list CHANGES update state; a change resets the background so a new idle
  // group (persona switch) is shown immediately instead of waiting for `ended`.
  const mediaJsonRef = useRef('')
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const base = bridgeBase()
        const [bg, task] = await Promise.all([
          fetch(`${base}/api/media/bg-images`).then(r => r.json() as Promise<{ media: BgMedia[] }>),
          fetch(`${base}/api/media/task-videos`).then(r => r.json() as Promise<{ videos: string[] }>),
        ])
        if (cancelled) return
        const media = Array.isArray(bg.media) ? bg.media : []
        const videos = Array.isArray(task.videos) ? task.videos : []
        const json = JSON.stringify([media, videos])
        if (json === mediaJsonRef.current) return
        mediaJsonRef.current = json
        bgMediaRef.current = media
        setBgMedia(media)
        setTaskVideos(videos.map(name => `${base}/media/task-videos/${encodeURIComponent(name)}`))
        resetBg()
      } catch (err) {
        console.error('[ui-voice] companion media list failed:', err)
      }
    }
    void load()
    const timer = window.setInterval(load, 30000)
    const onPersonaChange = () => { void load() }
    window.addEventListener('dsh-voice:persona', onPersonaChange)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('dsh-voice:persona', onPersonaChange)
    }
  }, [resetBg])

  // Follow the shared companion visibility (the toggle flips it live).
  useEffect(() => {
    return companion.subscribe(() => setVisible(companion.visible))
  }, [companion])

  // Follow the speaker's speaking state.
  useEffect(() => {
    return speaker.subscribe(() => setSpeaking(speaker.speaking))
  }, [speaker])

  // ── Foreground task frame: show while speaking, loop, play out on end ─────
  const hideTaskFrame = useCallback(() => {
    const vid = taskRef.current
    if (vid !== null) {
      vid.pause()
      vid.currentTime = 0
      vid.style.opacity = '0'
    }
    taskPlayingRef.current = false
    taskPendingStopRef.current = false
  }, [])

  const onTaskEnded = useCallback(() => {
    if (taskPendingStopRef.current) {
      hideTaskFrame()
      return
    }
    // Reply still going: loop so the animation never freezes on a black frame.
    const vid = taskRef.current
    if (vid !== null) {
      vid.currentTime = 0
      void vid.play().catch(() => {})
    }
  }, [hideTaskFrame])

  useEffect(() => {
    const vid = taskRef.current
    if (speaking && !wasSpeakingRef.current) {
      // New reply started.
      if (taskVideos.length > 0) {
        if (taskPlayingRef.current) vid?.pause()
        taskPendingStopRef.current = false
        taskPlayingRef.current = true
        taskIndexRef.current = (taskIndexRef.current + 1) % taskVideos.length
        const src = taskVideos[taskIndexRef.current]
        if (vid !== null) {
          vid.src = src
          vid.style.opacity = '1'
          vid.load()
          const play = () => {
            vid.removeEventListener('canplay', play)
            void vid.play().catch(() => {})
          }
          vid.addEventListener('canplay', play)
          window.setTimeout(() => {
            if (taskPlayingRef.current && vid.paused) void vid.play().catch(() => {})
          }, 3000)
        }
      }
      // One background hop per reply (original: showNextBgMedia).
      rotateBgReply()
    } else if (!speaking && wasSpeakingRef.current) {
      if (taskPlayingRef.current) {
        taskPendingStopRef.current = true
        window.setTimeout(() => { if (taskPendingStopRef.current) hideTaskFrame() }, 30000)
      } else {
        hideTaskFrame()
      }
      if (taskRef.current === null) hideTaskFrame()
    }
    wasSpeakingRef.current = speaking
  }, [speaking, taskVideos, rotateBgReply, hideTaskFrame])

  // The digital-human video, once playing, owns the foreground: hide any task
  // frame so the two never compete.
  useEffect(() => {
    if (dhPlaying) hideTaskFrame()
  }, [dhPlaying, hideTaskFrame])

  // Digital human: poll the bridge task state every 4 s and drive playback.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const status = await dhStatus()
      if (cancelled || status === null) return
      setDh((prev) => {
        if (prev === null) return status
        if (
          prev.state === status.state &&
          prev.video_url === status.video_url &&
          prev.progress === status.progress &&
          prev.message === status.message
        ) return prev
        return status
      })
      driveDh(status)
    }
    void poll()
    const timer = window.setInterval(poll, 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  /** Silence both filler layers (a real segment is taking over, or we stop). */
  const stopWarmup = useCallback(() => {
    const clip = warmVidRef.current
    if (clip !== null) {
      clip.pause()
      clip.currentTime = 0
      clip.style.opacity = '0'
    }
    const audio = warmRef.current
    if (audio !== null) {
      audio.pause()
      audio.currentTime = 0
    }
  }, [])

  const stopDh = useCallback(() => {
    dhHoldingRef.current = false
    const vid = dhRef.current
    if (vid !== null) {
      vid.pause()
      vid.currentTime = 0
      vid.style.opacity = '0'
    }
    stopWarmup()
    setDhPlayingBoth(false)
  }, [setDhPlayingBoth, stopWarmup])

  /** Play one filler line (random pick). False when nothing is available.
   *  Prefers the lip-synced clip (she actually talks); falls back to audio-only
   *  until the bridge finishes rendering the clip. */
  const playWarmup = useCallback((kind: 'open' | 'mid'): boolean => {
    if (!readDigitalHuman()) return false
    const list = kind === 'open' ? warmupRef.current?.open : warmupRef.current?.mid
    if (list === undefined || list.length === 0) return false
    const item = list[Math.floor(Math.random() * list.length)]
    if (item === undefined) return false
    const base = bridgeBase()
    const clip = warmVidRef.current
    if (item.video !== null && clip !== null) {
      clip.src = `${base}${item.video}`
      clip.style.opacity = '1'
      void clip.play().catch(() => {})
      return true
    }
    const audio = warmRef.current
    if (audio === null) return false
    audio.src = `${base}${item.audio}`
    void audio.play().catch(() => {})
    return true
  }, [])

  // A reply was accepted by the bridge: speak up IMMEDIATELY. The first video
  // segment is ten-plus seconds away, and total silence reads as "disconnected".
  // Any leftover segment from the previous reply is cut first so the two audio
  // tracks never overlap.
  useEffect(() => {
    return onDhWarmup((warmup) => {
      warmupRef.current = warmup
      warmMidCountRef.current = 0
      warmMidAtRef.current = 0
      // 受理即视为「还在生成」：状态轮询要 4s 才跟上，暖场续接不能等它
      dhPendingRef.current = true
      if (!readDigitalHuman()) return
      stopDh()
      // 一个用户回合可能提交两次（先 first 段、4s 后再 last 段）。第二次
      // 不该再「嗯，我看看啊」一次——同一回合里开场暖场只出声一遍。
      const now = Date.now()
      if (now - warmLastOpenRef.current > 8000) {
        warmLastOpenRef.current = now
        playWarmup('open')
      }
    })
  }, [playWarmup, stopDh])

  /** Queue ran dry mid-reply: fill the gap with one filler line (rate-limited). */
  const maybeMidWarmup = useCallback((): boolean => {
    const max = warmupRef.current?.max_mid ?? 3
    if (warmMidCountRef.current >= max) return false
    const now = Date.now()
    if (now - warmMidAtRef.current < 1500) return false
    if (!playWarmup('mid')) return false
    warmMidCountRef.current += 1
    warmMidAtRef.current = now
    return true
  }, [playWarmup])

  // 用户占用麦克风/说话（interruptReply）：停止数字人视频播放。
  useEffect(() => {
    return companion.subscribeInterrupt(() => {
      stopDh()
      dhQueueRef.current = []
      dhQueuePlayedRef.current = 0
      if (dhQueueCodeRef.current !== '') {
        handledDhRef.current.add(dhQueueCodeRef.current)
      }
    })
  }, [companion, stopDh])

  /** Play the next queued segment video (or stop when the playlist is done). */
  const playNextDh = useCallback(() => {
    const vid = dhRef.current
    const next = dhQueueRef.current[dhQueuePlayedRef.current]
    if (vid === null || next === undefined) {
      setDhPlayingBoth(false)
      return
    }
    // 正片到了：暖场必须立刻闭嘴（它是占位用的，绝不能盖住真实语音）
    stopWarmup()
    vid.style.opacity = '1'
    vid.src = next
    void vid.play().catch(() => {})
    setDhPlayingBoth(true)
  }, [setDhPlayingBoth, stopWarmup])

  const driveDh = (status: DhStatus): void => {
    const code = status.code
    if (!code) return
    if (!readDigitalHuman()) {
      dhQueueRef.current = []
      stopDh()
      return
    }
    if (code !== dhQueueCodeRef.current) {
      dhQueueCodeRef.current = code
      dhQueueRef.current = []
      dhQueuePlayedRef.current = 0
      handledDhRef.current.delete(code)
      stopDh()
    }
    if (handledDhRef.current.has(code)) return
    // 桥接是否还在往下出段（决定播空时是停帧等，还是收尾回待机）
    dhPendingRef.current = status.state === 'tts' || status.state === 'generating'
    if (status.state === 'discarded') {
      handledDhRef.current.add(code)
      waitingDhRef.current = null
      dhPendingRef.current = false
      dhQueueRef.current = []
      stopDh()
      return
    }
    if (status.state === 'error' && status.pending === 0) {
      handledDhRef.current.add(code)
      waitingDhRef.current = null
      dhPendingRef.current = false
      dhQueueRef.current = []
      stopDh()
      if (status.text) {
        void tts(status.text)
          .then(wav => speaker.speak(wav))
          .catch(err => console.error('[ui-voice] DH fallback TTS failed:', err))
      }
      return
    }
    if (status.state === 'tts' || status.state === 'generating') {
      const now = Date.now()
      const timeoutMs = 60000 + (status.total_segments || 1) * 25000
      if (waitingDhRef.current === null || waitingDhRef.current.code !== code) {
        waitingDhRef.current = { code, at: now }
      } else if (now - waitingDhRef.current.at > timeoutMs) {
        handledDhRef.current.add(code)
        waitingDhRef.current = null
        dhPendingRef.current = false
        dhQueueRef.current = []
        dhDiscard(code)
        stopDh()
        if (status.text) {
          void tts(status.text)
            .then(wav => speaker.speak(wav))
            .catch(err => console.error('[ui-voice] DH timeout TTS failed:', err))
        }
        return
      }
    }
    if (status.state === 'generating' || status.state === 'done') {
      const base = bridgeBase()
      for (const v of status.videos ?? []) {
        const url = `${base}${v.video_url}`
        if (!dhQueueRef.current.includes(url)) dhQueueRef.current.push(url)
      }
      if (status.state === 'done') {
        handledDhRef.current.add(code)
        waitingDhRef.current = null
      }
      if (dhHoldingRef.current) {
        // 停帧等待中：新段一到就续播（停帧期间 dhPlaying 仍为 true，
        // 不能走下面的「未在播放」分支，否则永远醒不过来）
        if (dhQueuePlayedRef.current < dhQueueRef.current.length) {
          dhHoldingRef.current = false
          playNextDh()
        } else if (status.state === 'done') {
          dhHoldingRef.current = false
          stopDh()  // 全部段都播完了：正常收尾
        }
      } else if (!dhPlayingRef.current && dhQueuePlayedRef.current < dhQueueRef.current.length) {
        playNextDh()
      }
    }
  }

  // A new reply takes over: stop the digital human video so its audio never
  // overlaps the live TTS.
  useEffect(() => {
    if (!speaking || !dhPlaying) return
    const vid = dhRef.current
    if (vid !== null) {
      vid.pause()
      vid.currentTime = 0
      vid.style.opacity = '0'
    }
    setDhPlayingBoth(false)
  }, [speaking, dhPlaying, setDhPlayingBoth])

  const onDhEnded = useCallback(() => {
    dhQueuePlayedRef.current += 1
    if (dhQueuePlayedRef.current < dhQueueRef.current.length) {
      playNextDh()
      return
    }
    const vid = dhRef.current
    if (dhPendingRef.current && vid !== null) {
      // 还有后续段在生成：停在当前段最后一帧等它，别掉回待机动画。
      // 同时补一句暖场语音——画面停住 + 有声音，才像「在想」而不是卡死。
      dhHoldingRef.current = true
      vid.pause()
      maybeMidWarmup()
      return
    }
    setDhPlayingBoth(false)
    if (vid !== null) vid.style.opacity = '0'
    stopWarmup()  // 整条回复播完：暖场那帧也收掉，回到待机动画
  }, [playNextDh, setDhPlayingBoth, maybeMidWarmup, stopWarmup])

  /** A filler line finished but we are still waiting: top it up (bounded). */
  const onWarmEnded = useCallback(() => {
    if (!dhPendingRef.current) return
    window.setTimeout(() => {
      if (!dhPendingRef.current) return
      // ① 段间等待（画面停帧）或 ② 首段还没到（队列空、一段都没播过）
      const waitingFirst = dhQueuePlayedRef.current === 0 && dhQueueRef.current.length === 0
      if (dhHoldingRef.current || waitingFirst) maybeMidWarmup()
    }, 2500)
  }, [maybeMidWarmup])

  // ── Drag to reposition ────────────────────────────────────────────────────
  const beginMove = useCallback((clientX: number, clientY: number) => {
    if (moveRef.current !== null) return
    const base = posRef.current ?? defaultPos(widthPx, heightPx)
    moveRef.current = { startX: clientX, startY: clientY, base }
    const onMove = (move: PointerEvent) => {
      const m = moveRef.current
      if (m === null) return
      const nx = m.base.x + (move.clientX - m.startX)
      const ny = m.base.y + (move.clientY - m.startY)
      const cx = Math.max(0, Math.min(window.innerWidth - widthPx, nx))
      const cy = Math.max(0, Math.min(window.innerHeight - heightPx, ny))
      setPos({ x: cx, y: cy })
      posRef.current = { x: cx, y: cy }
    }
    const onUp = () => {
      moveRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(posRef.current ?? { x: 0, y: 0 }))
      } catch {
        // ignore
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [widthPx, heightPx])

  const resetPos = useCallback(() => {
    const next = defaultPos(widthPx, heightPx)
    setPos(next)
    posRef.current = next
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(next))
    } catch {
      // ignore
    }
  }, [widthPx, heightPx])

  // Resize width; height scales proportionally (persisted).
  const beginResize = useCallback((clientX: number) => {
    dragRef.current = { startX: clientX, startWidth: widthPx, current: widthPx }
    const onMove = (move: PointerEvent) => {
      const drag = dragRef.current
      if (drag === null) return
      const delta = move.clientX - drag.startX
      drag.current = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startWidth + delta))
      setWidthPx(drag.current)
    }
    const onUp = () => {
      const drag = dragRef.current
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (drag !== null) {
        try {
          localStorage.setItem(WIDTH_KEY, String(drag.current))
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [widthPx])

  // Re-clamp the saved position whenever the viewport resizes (e.g. opening or
  // closing devtools) so the card can never be left off-screen and look "gone".
  useEffect(() => {
    const onResize = () => {
      if (posRef.current === null) return
      const cl = {
        x: Math.max(4, Math.min(window.innerWidth - widthPx - 4, posRef.current.x)),
        y: Math.max(4, Math.min(window.innerHeight - heightPx - 4, posRef.current.y)),
      }
      posRef.current = cl
      setPos(cl)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [widthPx, heightPx])

  const dhBusy = dh !== null && (dh.state === 'tts' || dh.state === 'generating')

  const hasBgVideos = bgMedia.some(m => m.type === 'video')
  const hasBgImages = bgMedia.some(m => m.type === 'image')
  const nothing = !hasBgVideos && !hasBgImages && taskVideos.length === 0 && !dhPlaying && !dhBusy
  // Always render the card (videos never unmount); hide it with display:none when
  // the companion is toggled off or there is nothing to show.
  const shown = visible && !nothing

  // Portrait framing: height scales with width (capped to the viewport).
  const cardPos = (() => {
    const p = posRef.current ?? pos
    if (p) {
      // Clamp onto-screen in case a stale stored position is off-screen (e.g. a
      // prior resize in a different viewport) — otherwise the card would render
      // outside the viewport and appear "missing".
      return {
        x: Math.max(4, Math.min(window.innerWidth - widthPx - 4, p.x)),
        y: Math.max(4, Math.min(window.innerHeight - heightPx - 4, p.y)),
      }
    }
    return defaultPos(widthPx, heightPx)
  })()

  return (
    <div
      className={css.card}
      style={{
        position: 'fixed',
        left: `${cardPos.x}px`,
        top: `${cardPos.y}px`,
        width: `${widthPx}px`,
        height: `${heightPx}px`,
        zIndex: 9999,
        pointerEvents: 'auto',
        cursor: 'move',
        display: shown ? undefined : 'none',
        backgroundColor: '#0b0c10',
        backgroundImage: bgImageUrl || undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 22,
        boxShadow: '0 28px 70px -28px rgba(0,0,0,0.78), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.06)',
        overflow: 'hidden',
        userSelect: 'none',
      }}
      aria-hidden="true"
      draggable={false}
      onPointerDown={(event) => {
        // preventDefault blocks the browser's native (video/img) drag so the
        // card doesn't get "dragged away" when the user tries to move it.
        event.preventDefault()
        beginMove(event.clientX, event.clientY)
      }}
      onDoubleClick={resetPos}
      title="拖动移动,双击回默认位"
    >
      {/* Background crossfade layers (idle loop) */}
      <video ref={bgA} style={VIDEO_STYLE} muted playsInline preload="auto" draggable={false} onEnded={onBgVideoEnded} />
      <video ref={bgB} style={VIDEO_STYLE} muted playsInline preload="auto" draggable={false} onEnded={onBgVideoEnded} />
      {/* Foreground task/avatar frame (load on demand) */}
      <video ref={taskRef} style={VIDEO_STYLE} muted playsInline preload="metadata" draggable={false} onEnded={onTaskEnded} />
      {/* Digital-human frame (load on demand, carries the TTS audio) */}
      <video ref={dhRef} style={VIDEO_STYLE} playsInline preload="metadata" draggable={false} onEnded={onDhEnded} />
      {/* Filler clip: pre-rendered lip-synced "嗯…" in the SAME avatar, so the
          gap looks like her thinking instead of a frozen/idle background. */}
      <video ref={warmVidRef} style={VIDEO_STYLE} playsInline preload="auto" draggable={false} onEnded={onWarmEnded} />
      {/* Audio-only fallback while the clip above has not been rendered yet. */}
      <audio ref={warmRef} preload="auto" onEnded={onWarmEnded} style={WARMUP_AUDIO_STYLE} />
      {/* 只在失败/取消时给一行提示。生成中的「第 N/M 段」进度和进度条已移除，
          数字人窗口只留画面，不叠加任何文字。 */}
      {readDigitalHuman() && dh !== null
        && (dh.state === 'error' || dh.state === 'discarded') && (
        <div style={DH_SEG_STYLE}>
          <span>{dhSegText(dh)}</span>
        </div>
      )}
      {/* 语音总开关关着：整条管道都不提交，明确提示 */}
      {readDigitalHuman() && !readVoiceEnabled() && (
        <div style={DH_HINT_STYLE}>语音总开关关着 · 数字人不会提交</div>
      )}
      {/* Resize handle (bottom-right corner) */}
      <div
        className={css.handle}
        onPointerDown={(event) => {
          event.stopPropagation()
          beginResize(event.clientX)
        }}
        title="拖动调宽"
      />
    </div>
  )
})
