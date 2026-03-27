/**
 * Streaming type definitions.
 *
 * LarkClient is a structural type matching the subset of
 * @larksuiteoapi/node-sdk's Client that we actually use.
 * No import needed — the consumer passes their own instance.
 */

// ---------------------------------------------------------------------------
// Minimal Lark Client shape (structural typing, no SDK import)
// ---------------------------------------------------------------------------

export interface LarkClient {
  cardkit: {
    v1: {
      card: {
        create: (payload: {
          data: { type: string; data: string }
        }) => Promise<{ code?: number; msg?: string; data?: { card_id: string } }>

        update: (payload: {
          data: {
            card: { type: 'card_json'; data: string }
            sequence: number
          }
          path: { card_id: string }
        }) => Promise<{ code?: number; msg?: string }>

        settings: (payload: {
          data: { settings: string; sequence: number }
          path: { card_id: string }
        }) => Promise<{ code?: number; msg?: string }>
      }

      cardElement: {
        content: (payload: {
          data: { content: string; sequence: number }
          path: { card_id: string; element_id: string }
        }) => Promise<{ code?: number; msg?: string }>
      }
    }
  }

  im: {
    message: {
      create: (payload: {
        params: { receive_id_type: 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email' }
        data: { receive_id: string; msg_type: string; content: string }
      }) => Promise<{ data?: { message_id?: string } }>

      reply: (payload: {
        path: { message_id: string }
        data: { content: string; msg_type: string; reply_in_thread?: boolean }
      }) => Promise<{ data?: { message_id?: string } }>

      patch: (payload: {
        path: { message_id: string }
        data: { content: string }
      }) => Promise<unknown>
    }
  }
}

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface StreamingOptions {
  /** Reply to a specific message ID. */
  replyTo?: string
  /** Reply within a thread. */
  replyInThread?: boolean
}

export interface CompleteOptions {
  /** Override card text for the final state. If omitted, uses the last streamed text. */
  text?: string
  /** Elapsed time in ms — shown in the card footer. */
  elapsed?: number
}

// ---------------------------------------------------------------------------
// StreamingManager interface
// ---------------------------------------------------------------------------

export interface StreamingManager {
  /**
   * Send or update a streaming card.
   *
   * First call creates the card ("Thinking...").
   * Subsequent calls stream text with typewriter animation.
   */
  update(
    chatId: string,
    sessionId: number | string,
    text: string,
    options?: StreamingOptions,
  ): Promise<void>

  /**
   * Finalize a streaming card — close streaming mode, show final text.
   * Returns true if the card was finalized, false if the session didn't exist or couldn't complete.
   */
  complete(
    chatId: string,
    sessionId: number | string,
    options?: CompleteOptions,
  ): Promise<boolean>

  /**
   * Abort a streaming card — close with partial text preserved.
   */
  abort(chatId: string, sessionId: number | string): Promise<void>

  /**
   * Abort all active sessions and release resources.
   */
  dispose(): void
}
