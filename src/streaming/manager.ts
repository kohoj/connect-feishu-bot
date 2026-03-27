/**
 * StreamingManager — routes update/complete/abort calls to CardSessions.
 *
 * One manager per client. Many concurrent sessions, each identified
 * by chatId + sessionId. Sessions are created on first update and
 * removed on complete/abort.
 */

import type {
  LarkClient,
  StreamingOptions,
  CompleteOptions,
  StreamingManager,
} from './types.js'
import { CardSession } from './session.js'

function sessionKey(chatId: string, sessionId: number | string): string {
  return `${chatId}:${sessionId}`
}

export class StreamingManagerImpl implements StreamingManager {
  private readonly client: LarkClient
  private readonly sessions = new Map<string, CardSession>()

  constructor(client: LarkClient) {
    this.client = client
  }

  async update(
    chatId: string,
    sessionId: number | string,
    text: string,
    options?: StreamingOptions,
  ): Promise<void> {
    const key = sessionKey(chatId, sessionId)
    let session = this.sessions.get(key)

    if (!session) {
      session = new CardSession(this.client, chatId, options)
      this.sessions.set(key, session)
    }

    await session.update(text)
  }

  async complete(
    chatId: string,
    sessionId: number | string,
    options?: CompleteOptions,
  ): Promise<boolean> {
    const key = sessionKey(chatId, sessionId)
    const session = this.sessions.get(key)
    if (!session) return false

    const ok = await session.complete(options)
    this.sessions.delete(key)
    return ok
  }

  async abort(chatId: string, sessionId: number | string): Promise<void> {
    const key = sessionKey(chatId, sessionId)
    const session = this.sessions.get(key)
    if (!session) return

    await session.abort()
    this.sessions.delete(key)
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (!session.isTerminal) {
        void session.abort()
      }
    }
    this.sessions.clear()
  }
}
