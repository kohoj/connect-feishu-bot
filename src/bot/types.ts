/**
 * Type definitions for the FeishuBot module.
 */
import { log } from '../log.js'
import type * as lark from '@larksuiteoapi/node-sdk'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Optional logger — pass one to see what the bot is doing. Silent by default. */
export interface Logger {
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
}

/** A no-op logger. The package is silent unless you tell it otherwise. */
export const nullLogger: Logger = { info() {}, warn() {} }

export interface FeishuBotOptions {
  /** Feishu App ID */
  appId: string
  /** Feishu App Secret */
  appSecret: string
  /** Callback when a message is received (after filtering and parsing) */
  onMessage: (message: IncomingMessage) => void
  /** Directory for downloaded attachments. Defaults to os.tmpdir() */
  downloadDir?: string
  /** Lark domain. Defaults to lark.Domain.Feishu */
  domain?: typeof lark.Domain.Feishu | typeof lark.Domain.Lark
  /** Additional event handlers for the EventDispatcher */
  extraEvents?: Record<string, (data: Record<string, unknown>) => Promise<void>>
  /** Logger for debug output. Silent by default. */
  logger?: Logger
}

// ---------------------------------------------------------------------------
// Incoming message
// ---------------------------------------------------------------------------

export interface IncomingMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  senderId: string
  senderName?: string
  text: string
  attachments: string[]
  messageType: string
  mentions?: unknown[]
  parsedContent?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface RecipientTarget {
  receiveIdType: 'open_id' | 'chat_id'
  receiveId: string
}

export interface MentionTarget {
  displayName: string
  openId?: string
  appId?: string
}

export interface ParsedMentionTarget extends MentionTarget {
  aliases: string[]
}

export interface SenderIds {
  openId?: string
  userId?: string
  unionId?: string
}

export interface TokenEntry {
  token: string
  expiresAt: number
}

export interface TokenCache {
  tenant?: TokenEntry
  app?: TokenEntry
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic']
export const AUDIO_EXTS = ['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.opus']
export const VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.mkv', '.webm']

export const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024
export const RETRY_MAX_ATTEMPTS = 3
export const RETRY_BASE_DELAY_MS = 1000
export const TOKEN_REFRESH_SKEW_MS = 60 * 1000
export const CHAT_RECIPIENT_PREFIX = 'chat:'
export const OPEN_RECIPIENT_PREFIX = 'open:'
export const CHAT_MENTION_CACHE_TTL_MS = 5 * 60 * 1000
export const MAX_CHAT_MENTION_CACHES = 100

/** Resolve a Feishu target string to receive_id_type + receive_id. */
export function resolveRecipientTarget(recipient?: string): RecipientTarget | null {
  const normalized = (recipient || '').trim()
  if (normalized.startsWith(CHAT_RECIPIENT_PREFIX)) {
    const id = normalized.slice(CHAT_RECIPIENT_PREFIX.length).trim()
    if (id) return { receiveIdType: 'chat_id', receiveId: id }
  }
  if (normalized.startsWith(OPEN_RECIPIENT_PREFIX)) {
    const id = normalized.slice(OPEN_RECIPIENT_PREFIX.length).trim()
    if (id) return { receiveIdType: 'open_id', receiveId: id }
  }
  if (!normalized) return null
  if (normalized.startsWith('oc_')) return { receiveIdType: 'chat_id', receiveId: normalized }
  if (normalized.startsWith('on_')) return { receiveIdType: 'union_id' as 'open_id', receiveId: normalized }
  if (normalized.includes('@')) return { receiveIdType: 'email' as 'open_id', receiveId: normalized }
  return { receiveIdType: 'open_id', receiveId: normalized }
}

export const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  if (code && RETRYABLE_CODES.has(code)) return true
  const message = (err as { message?: string }).message
  if (message && /socket (hang up|disconnected)|network (error|timeout)/i.test(message))
    return true
  return false
}

export function sanitizeError(err: unknown): { message?: string; code?: string; status?: number } {
  if (!err || typeof err !== 'object') return {}
  return {
    message: (err as Error).message,
    code: (err as { code?: string }).code,
    status: (err as { status?: number }).status,
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function maskId(id: string): string {
  if (!id || id.length <= 6) return '***'
  return `${id.slice(0, 3)}...${id.slice(-3)}`
}

export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < RETRY_MAX_ATTEMPTS && isRetryableError(err)) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
        log.warn(
          `${label} failed (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), ` +
            `retrying in ${delay}ms: ${(err as { code?: string }).code ?? 'unknown error'}`,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      } else {
        throw err
      }
    }
  }
  throw lastError as Error
}
