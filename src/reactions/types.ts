/**
 * Reaction types.
 *
 * LarkReactionClient is a structural type — same philosophy as
 * streaming/types.ts. No SDK import, just the shape we need.
 */

export interface LarkReactionClient {
  im: {
    messageReaction: {
      create: (payload: {
        path: { message_id: string }
        data: { reaction_type: { emoji_type: string } }
      }) => Promise<{ data?: { reaction_id?: string } }>

      delete: (payload: {
        path: { message_id: string; reaction_id: string }
      }) => Promise<unknown>
    }
  }
}

export interface AcknowledgeOptions {
  hasAttachment?: boolean
}

export interface ReactionsManager {
  /**
   * React to an incoming message — immediate, content-aware.
   * Starts escalation timers automatically.
   */
  acknowledge(
    chatId: string,
    messageId: string,
    text: string,
    options?: AcknowledgeOptions,
  ): Promise<void>

  /**
   * Remove the pending reaction for a chat.
   * Call when the streaming card appears or the response is sent.
   */
  clear(chatId: string): Promise<void>

  /** Clean up all timers. */
  dispose(): void
}
