/**
 * Reaction lifecycle manager.
 *
 * Three acts, one arc:
 *   I.   Acknowledge — instant reaction on the user's message
 *   II.  Escalation  — emoji evolves if processing takes time
 *   III. Curtain call — reaction removed when the response arrives
 *
 * Race-condition hardened:
 *   - Rapid messages: old pending is cleared before new one is stored.
 *   - clear() during in-flight acknowledge(): generation counter
 *     prevents stale reactions from being stored.
 *   - clear() during in-flight swap(): generation check after API call
 *     cleans up orphaned reactions.
 *   - Escalation timers are chained, not parallel — the deep-work
 *     timer only starts after the first escalation completes.
 */

import type {
  LarkReactionClient,
  AcknowledgeOptions,
  ReactionsManager,
} from './types.js'
import { classify, ESCALATION_EMOJI, DEEP_WORK_EMOJI } from './classifier.js'

const ESCALATE_MS = 5_000
const DEEP_WORK_MS = 15_000

interface PendingReaction {
  messageId: string
  reactionId: string
  generation: number
  escalateTimer?: ReturnType<typeof setTimeout>
  deepWorkTimer?: ReturnType<typeof setTimeout>
}

export class ReactionsManagerImpl implements ReactionsManager {
  private readonly client: LarkReactionClient
  private readonly pending = new Map<string, PendingReaction>()
  private readonly generation = new Map<string, number>()

  constructor(client: LarkReactionClient) {
    this.client = client
  }

  // -----------------------------------------------------------------
  // Act I: Acknowledge
  // -----------------------------------------------------------------

  async acknowledge(
    chatId: string,
    messageId: string,
    text: string,
    options?: AcknowledgeOptions,
  ): Promise<void> {
    // Clear any existing reaction for this chat (handles rapid messages).
    await this.clear(chatId)

    const gen = this.advanceGeneration(chatId)
    const emoji = classify(text, options?.hasAttachment ?? false)

    try {
      const resp = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })

      // Stale check: if clear() was called while we were awaiting,
      // the generation has advanced — discard this reaction.
      if (this.generation.get(chatId) !== gen) {
        this.deleteReactionQuietly(messageId, resp?.data?.reaction_id)
        return
      }

      const reactionId = resp?.data?.reaction_id
      if (!reactionId) return

      const entry: PendingReaction = { messageId, reactionId, generation: gen }

      // Act II: Escalation — chained, not parallel.
      // Deep-work timer only starts after the first escalation completes.
      entry.escalateTimer = setTimeout(() => {
        void this.swap(chatId, ESCALATION_EMOJI).then(() => {
          entry.deepWorkTimer = setTimeout(() => {
            void this.swap(chatId, DEEP_WORK_EMOJI)
          }, DEEP_WORK_MS - ESCALATE_MS)
        })
      }, ESCALATE_MS)

      this.pending.set(chatId, entry)
    } catch {
      // Reactions are garnish, never the main course.
    }
  }

  // -----------------------------------------------------------------
  // Act III: Curtain call
  // -----------------------------------------------------------------

  async clear(chatId: string): Promise<void> {
    // Advance generation so any in-flight acknowledge/swap becomes stale.
    this.advanceGeneration(chatId)

    const entry = this.pending.get(chatId)
    if (!entry) return

    this.cancelTimers(entry)
    this.pending.delete(chatId)

    this.deleteReactionQuietly(entry.messageId, entry.reactionId)
  }

  dispose(): void {
    for (const entry of this.pending.values()) this.cancelTimers(entry)
    this.pending.clear()
    this.generation.clear()
  }

  // -----------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------

  private async swap(chatId: string, newEmoji: string): Promise<void> {
    const entry = this.pending.get(chatId)
    if (!entry) return

    const gen = entry.generation

    try {
      // Fire-and-forget the delete to minimize the visible gap.
      this.deleteReactionQuietly(entry.messageId, entry.reactionId)

      const resp = await this.client.im.messageReaction.create({
        path: { message_id: entry.messageId },
        data: { reaction_type: { emoji_type: newEmoji } },
      })

      // Stale check: if clear() or new acknowledge() happened during swap,
      // this reaction is orphaned — clean it up.
      if (this.pending.get(chatId)?.generation !== gen) {
        this.deleteReactionQuietly(entry.messageId, resp?.data?.reaction_id)
        return
      }

      const newId = resp?.data?.reaction_id
      if (newId) entry.reactionId = newId
    } catch {
      // Best effort.
    }
  }

  private advanceGeneration(chatId: string): number {
    const gen = (this.generation.get(chatId) ?? 0) + 1
    this.generation.set(chatId, gen)
    return gen
  }

  private deleteReactionQuietly(messageId: string, reactionId?: string): void {
    if (!reactionId) return
    void this.client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => {})
  }

  private cancelTimers(entry: PendingReaction): void {
    if (entry.escalateTimer) clearTimeout(entry.escalateTimer)
    if (entry.deepWorkTimer) clearTimeout(entry.deepWorkTimer)
  }
}
