/**
 * FeishuBot — reusable Feishu/Lark bot class.
 *
 * Encapsulates all Feishu SDK logic: WebSocket event handling, message
 * parsing, file download, mention resolution, identity management, and
 * sending messages/files/cards.
 */
import { log, setLogger } from '../log.js'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as lark from '@larksuiteoapi/node-sdk'
import type {
  FeishuBotOptions,
  RecipientTarget,
  Logger,
} from './types.js'
import {
  withRetry,
  resolveRecipientTarget,
  nullLogger,
  IMAGE_EXTS,
  AUDIO_EXTS,
  VIDEO_EXTS,
  MAX_FILE_SIZE_BYTES,
} from './types.js'
import type { IdentityState } from './identity.js'
import { loadBotName } from './identity.js'
import type { MentionState } from './mentions.js'
import { normalizeOutgoingMentions } from './mentions.js'
import { handleMessageEvent } from './receiver.js'

// ---------------------------------------------------------------------------
// FeishuBot
// ---------------------------------------------------------------------------

export class FeishuBot {
  /** The underlying Lark SDK client. Public for streaming/reactions usage. */
  client: lark.Client | null = null

  private wsClient: lark.WSClient | null = null
  private connected = false
  private opts: FeishuBotOptions

  // Identity state (shared with identity.ts functions)
  private identity: IdentityState

  // Mention state (shared with mentions.ts functions)
  private mention: MentionState

  constructor(opts: FeishuBotOptions) {
    this.opts = opts
    setLogger(opts.logger)
    this.identity = {
      client: null,
      appId: opts.appId,
      appSecret: opts.appSecret,
      botName: null,
      botOpenId: null,
      botUserId: null,
      senderDisplayNameById: new Map(),
      contactProfileReadUnavailable: false,
      tokenCache: {},
    }
    this.mention = {
      chatMentionTargetByChatId: new Map(),
      chatMentionCacheExpiresAtByChatId: new Map(),
      chatMemberReadUnavailable: false,
    }
  }

  // -------------------------------------------------------------------------
  // Public getters
  // -------------------------------------------------------------------------

  get botName(): string | null {
    return this.identity.botName
  }

  get botOpenId(): string | null {
    return this.identity.botOpenId
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    const baseConfig = {
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.opts.domain ?? lark.Domain.Feishu,
    }

    try {
      this.client = new lark.Client(baseConfig)
      this.identity.client = this.client
      await loadBotName(this.identity)

      const extraEvents = this.opts.extraEvents ?? {}
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: Record<string, unknown>) => {
          await handleMessageEvent(
            data,
            this.client!,
            this.identity,
            this.mention,
            this.opts,
          )
        },
        p2p_chat_create: async (_data: Record<string, unknown>) => {
          log.info('Feishu p2p_chat_create event received')
        },
        ...extraEvents,
      })

      this.wsClient = new lark.WSClient({
        ...baseConfig,
        loggerLevel: lark.LoggerLevel.info,
      })

      await this.wsClient.start({ eventDispatcher })
      this.connected = true
      log.info('Feishu bot connected via WebSocket')
    } catch (error) {
      this.connected = false
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true })
      } catch (err) {
        log.warn('Feishu WSClient close error:', (err as Error).message)
      }
      this.wsClient = null
    }
    this.client = null
    this.identity.client = null
    this.identity.botName = null
    this.identity.botOpenId = null
    this.identity.botUserId = null
    this.identity.senderDisplayNameById.clear()
    this.identity.contactProfileReadUnavailable = false
    this.identity.tokenCache = {}
    this.mention.chatMentionTargetByChatId.clear()
    this.mention.chatMentionCacheExpiresAtByChatId.clear()
    this.mention.chatMemberReadUnavailable = false
    this.connected = false
    log.info('Feishu bot disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async sendText(target: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Feishu not connected')

    const resolved = resolveRecipientTarget(target)
    if (!resolved) throw new Error('No valid Feishu recipient')

    const normalizedText = await this.normalizeMentions(text, resolved.receiveId)
    await withRetry(
      () =>
        this.client!.im.message.create({
          params: { receive_id_type: resolved.receiveIdType },
          data: {
            receive_id: resolved.receiveId,
            msg_type: 'text',
            content: JSON.stringify({ text: normalizedText }),
          },
        }),
      'Feishu send text',
    )
  }

  async sendFile(
    target: string,
    filePath: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Feishu not connected')

    const resolved = resolveRecipientTarget(target)
    if (!resolved) throw new Error('No valid Feishu recipient')

    const stat = await fsp.stat(filePath).catch(() => null)
    if (!stat) throw new Error(`File not found: ${filePath}`)
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB), limit is 30MB`)
    }

    const ext = path.extname(filePath).toLowerCase()
    const fileData = await fsp.readFile(filePath)

    if (IMAGE_EXTS.includes(ext)) {
      const imgRes = await withRetry(
        () => this.client!.im.image.create({ data: { image_type: 'message', image: fileData } }),
        'Feishu upload image',
      )
      const imageKey = imgRes?.image_key
      if (!imageKey) throw new Error('Image upload returned no key')
      await this.sendImMessage(resolved, 'image', { image_key: imageKey })
    } else {
      const fileType = AUDIO_EXTS.includes(ext) ? 'opus' : VIDEO_EXTS.includes(ext) ? 'mp4' : 'stream'
      const msgType = AUDIO_EXTS.includes(ext) ? 'audio' : VIDEO_EXTS.includes(ext) ? 'media' : 'file'
      const fileRes = await withRetry(
        () => this.client!.im.file.create({ data: { file_type: fileType, file_name: path.basename(filePath), file: fileData } }),
        `Feishu upload ${msgType}`,
      )
      const fileKey = fileRes?.file_key
      if (!fileKey) throw new Error(`${msgType} upload returned no key`)
      await this.sendImMessage(resolved, msgType, { file_key: fileKey })
    }
  }

  private async sendImMessage(
    target: RecipientTarget,
    msgType: string,
    content: Record<string, string>,
  ): Promise<void> {
    await withRetry(
      () => this.client!.im.message.create({
        params: { receive_id_type: target.receiveIdType },
        data: { receive_id: target.receiveId, msg_type: msgType, content: JSON.stringify(content) },
      }),
      `Feishu send ${msgType}`,
    )
  }

  async sendCard(
    target: string,
    card: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (!this.client) return undefined

    const resolved = resolveRecipientTarget(target)
    if (!resolved) return undefined

    try {
      const result = await this.client.im.message.create({
        params: { receive_id_type: resolved.receiveIdType },
        data: {
          receive_id: resolved.receiveId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      const r = result as { data?: { message_id?: string }; message_id?: string }
      const messageId = r?.data?.message_id || r?.message_id
      return messageId ? String(messageId) : undefined
    } catch {
      return undefined
    }
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    if (!this.client) return
    try {
      await this.client.im.message.update({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
    } catch (err) {
      log.warn('Feishu editMessage failed:', (err as Error).message)
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.client) return
    try {
      await this.client.im.message.delete({
        path: { message_id: messageId },
      })
    } catch (err) {
      log.warn('Feishu deleteMessage failed:', (err as Error).message)
    }
  }

  // -------------------------------------------------------------------------
  // Mention normalization (outgoing)
  // -------------------------------------------------------------------------

  async normalizeMentions(text: string, chatId: string): Promise<string> {
    const resolved = resolveRecipientTarget(chatId)
    if (!resolved) return text
    return normalizeOutgoingMentions(text, resolved, this.mention, this.identity)
  }

}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBot(opts: FeishuBotOptions): FeishuBot {
  return new FeishuBot(opts)
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { FeishuBotOptions, IncomingMessage, Logger } from './types.js'
