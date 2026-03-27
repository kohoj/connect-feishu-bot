/**
 * CardSession — the lifecycle of a single streaming card.
 *
 * Like a tracking shot through a model railway: each phase
 * transitions with mechanical precision, and every failure
 * has a graceful fallback waiting in the wings.
 *
 *   idle → creating → streaming → completed
 *                               → aborted
 */

import type { LarkClient, StreamingOptions, CompleteOptions } from './types.js'

const CREATE_TIMEOUT_MS = 10_000
import { FlushController } from './flush.js'
import {
  thinkingCard,
  completeCard,
  fallbackThinkingCard,
  fallbackStreamingCard,
  fallbackCompleteCard,
  STREAMING_ELEMENT_ID,
} from './cards.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CARDKIT_THROTTLE_MS = 100
const PATCH_THROTTLE_MS = 1500

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'creating' | 'streaming' | 'completed' | 'aborted'

const TRANSITIONS: Record<Phase, Set<Phase>> = {
  idle: new Set(['creating', 'aborted']),
  creating: new Set(['streaming', 'completed', 'aborted']),
  streaming: new Set(['completed', 'aborted']),
  completed: new Set(),
  aborted: new Set(),
}

function isTerminal(phase: Phase): boolean {
  return phase === 'completed' || phase === 'aborted'
}

// ---------------------------------------------------------------------------
// CardSession
// ---------------------------------------------------------------------------

export class CardSession {
  private phase: Phase = 'idle'
  private cardId: string | null = null
  private messageId: string | null = null
  private sequence = 0
  private text = ''
  private fallback = false
  private createPromise: Promise<void> | null = null

  private readonly client: LarkClient
  private readonly chatId: string
  private readonly options: StreamingOptions
  private readonly flush: FlushController

  constructor(client: LarkClient, chatId: string, options: StreamingOptions = {}) {
    this.client = client
    this.chatId = chatId
    this.options = options
    this.flush = new FlushController(() => this.performFlush())
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  async update(text: string): Promise<void> {
    if (isTerminal(this.phase)) return
    this.text = text
    await this.ensureCardCreated()
    if (isTerminal(this.phase) || !this.messageId) return

    const throttle = this.fallback ? PATCH_THROTTLE_MS : CARDKIT_THROTTLE_MS
    await this.flush.scheduleFlush(throttle)
  }

  async complete(options?: CompleteOptions): Promise<boolean> {
    if (!this.transition('completed')) {
      console.warn(`[connect-feishu-bot] complete() rejected: phase=${this.phase}, cardId=${this.cardId}, messageId=${this.messageId}`)
      return false
    }

    this.flush.cancel()
    this.flush.complete()
    await this.flush.waitForFlush()

    if (this.createPromise) await this.createPromise

    if (!this.messageId) return true

    // Allow caller to override card text for the final state
    const finalText = options?.text ?? this.text

    try {
      if (this.cardId) {
        // Close streaming mode
        this.sequence += 1
        await withTimeout(this.client.cardkit.v1.card.settings({
          data: {
            settings: JSON.stringify({ streaming_mode: false }),
            sequence: this.sequence,
          },
          path: { card_id: this.cardId },
        }), CREATE_TIMEOUT_MS)

        // Final card update
        this.sequence += 1
        const finalCard = completeCard(finalText, options)
        await withTimeout(this.client.cardkit.v1.card.update({
          data: {
            card: { type: 'card_json' as const, data: JSON.stringify(finalCard) },
            sequence: this.sequence,
          },
          path: { card_id: this.cardId },
        }), CREATE_TIMEOUT_MS)
      } else {
        // IM fallback
        const card = fallbackCompleteCard(finalText, options)
        await withTimeout(this.client.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(card) },
        }), CREATE_TIMEOUT_MS)
      }
    } catch (err) {
      console.warn('[connect-feishu-bot] complete() card update failed:', String(err))
    }
    return true
  }

  async abort(): Promise<void> {
    if (!this.transition('aborted')) return

    this.flush.cancel()
    this.flush.complete()
    await this.flush.waitForFlush()

    if (this.createPromise) await this.createPromise

    if (!this.messageId) return

    try {
      if (this.cardId) {
        this.sequence += 1
        await withTimeout(this.client.cardkit.v1.card.settings({
          data: {
            settings: JSON.stringify({ streaming_mode: false }),
            sequence: this.sequence,
          },
          path: { card_id: this.cardId },
        }), CREATE_TIMEOUT_MS)

        this.sequence += 1
        const abortCard = completeCard(this.text || 'Aborted.', { elapsed: undefined })
        await withTimeout(this.client.cardkit.v1.card.update({
          data: {
            card: { type: 'card_json' as const, data: JSON.stringify(abortCard) },
            sequence: this.sequence,
          },
          path: { card_id: this.cardId },
        }), CREATE_TIMEOUT_MS)
      } else {
        const card = fallbackCompleteCard(this.text || 'Aborted.')
        await withTimeout(this.client.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(card) },
        }), CREATE_TIMEOUT_MS)
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  get isTerminal(): boolean {
    return isTerminal(this.phase)
  }

  // -----------------------------------------------------------------------
  // State machine
  // -----------------------------------------------------------------------

  private transition(to: Phase): boolean {
    if (this.phase === to) return false
    if (!TRANSITIONS[this.phase].has(to)) return false
    this.phase = to
    return true
  }

  // -----------------------------------------------------------------------
  // Card creation
  // -----------------------------------------------------------------------

  private async ensureCardCreated(): Promise<void> {
    if (this.messageId || this.phase === 'aborted') return
    if (this.createPromise) {
      await this.createPromise
      return
    }

    if (!this.transition('creating')) return

    this.createPromise = withTimeout(this.doCreate(), CREATE_TIMEOUT_MS)
    await this.createPromise
  }

  private async doCreate(): Promise<void> {
    try {
      // Try CardKit path first
      const card = thinkingCard()
      const createResp = await this.client.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(card) },
      })

      const cardId = createResp?.data?.card_id
      if (!cardId) throw new Error('card.create returned empty card_id')

      this.cardId = cardId
      this.sequence = 1

      // Send the card as an IM message
      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } })
      const sendResp = await this.sendCardMessage(content)

      this.messageId = sendResp
      this.transition('streaming')
    } catch (cardkitErr) {
      // CardKit failed — fall back to regular interactive card
      console.warn('[connect-feishu-bot] CardKit failed, trying IM fallback:', String(cardkitErr))
      this.cardId = null
      this.fallback = true

      try {
        const card = fallbackThinkingCard()
        const content = JSON.stringify(card)
        const msgId = await this.sendCardMessage(content)
        this.messageId = msgId
        this.transition('streaming')
      } catch (imErr) {
        console.warn('[connect-feishu-bot] IM fallback also failed:', String(imErr))
        this.transition('aborted')
      }
    }
  }

  private async sendCardMessage(content: string): Promise<string> {
    if (this.options.replyTo) {
      const resp = await this.client.im.message.reply({
        path: { message_id: this.options.replyTo },
        data: {
          content,
          msg_type: 'interactive',
          reply_in_thread: this.options.replyInThread,
        },
      })
      return resp?.data?.message_id ?? ''
    }

    const receiveIdType = resolveReceiveIdType(this.chatId)
    const resp = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: this.chatId,
        msg_type: 'interactive',
        content,
      },
    })
    return resp?.data?.message_id ?? ''
  }

  // -----------------------------------------------------------------------
  // Flush — the actual card update
  // -----------------------------------------------------------------------

  private async performFlush(): Promise<void> {
    if (!this.messageId || isTerminal(this.phase)) return

    try {
      if (this.cardId) {
        // CardKit streaming — typewriter effect
        this.sequence += 1
        await this.client.cardkit.v1.cardElement.content({
          data: {
            content: this.text,
            sequence: this.sequence,
          },
          path: {
            card_id: this.cardId,
            element_id: STREAMING_ELEMENT_ID,
          },
        })
      } else {
        // IM fallback — patch the card content
        const card = fallbackStreamingCard(this.text)
        await this.client.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(card) },
        })
      }
    } catch (err: unknown) {
      // Rate limit (230020) — skip this frame, don't degrade.
      const code = extractCode(err)
      if (code === 230020) return

      // Other CardKit error — disable CardKit, keep going via IM patch.
      if (this.cardId) {
        this.cardId = null
        this.fallback = true
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveReceiveIdType(id: string): 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email' {
  if (id.startsWith('oc_')) return 'chat_id'
  if (id.startsWith('ou_')) return 'open_id'
  if (id.startsWith('on_')) return 'union_id'
  if (id.includes('@')) return 'email'
  return 'open_id'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function extractCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  if (typeof e.code === 'number') return e.code
  const resp = e.response as Record<string, unknown> | undefined
  const data = resp?.data as Record<string, unknown> | undefined
  return typeof data?.code === 'number' ? data.code : undefined
}
