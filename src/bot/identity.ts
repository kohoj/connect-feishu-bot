/**
 * Bot identity — name loading, sender name resolution, token management.
 *
 * All methods receive the bot's internal state via a `BotState` reference
 * so the FeishuBot class can share mutable state without inheritance.
 */
import { log } from '../log.js'
import * as https from 'https'
import type * as lark from '@larksuiteoapi/node-sdk'
import type { SenderIds, TokenCache } from './types.js'
import {
  asRecord,
  asNonEmptyString,
  escapeRegExp,
  sanitizeError,
  TOKEN_REFRESH_SKEW_MS,
} from './types.js'

// ---------------------------------------------------------------------------
// Shared state shape (provided by FeishuBot)
// ---------------------------------------------------------------------------

export interface IdentityState {
  client: lark.Client | null
  appId: string
  appSecret: string
  botName: string | null
  botOpenId: string | null
  botUserId: string | null
  senderDisplayNameById: Map<string, string>
  contactProfileReadUnavailable: boolean
  tokenCache: TokenCache
}

// ---------------------------------------------------------------------------
// Bot name helpers
// ---------------------------------------------------------------------------

export function normalizeBotName(value: string | null): string {
  return (value || '').replace(/\s+/g, '').trim().toLowerCase()
}

export function isMentionMatchedToBot(
  mention: Record<string, unknown>,
  state: IdentityState,
): boolean {
  const idRecord = asRecord(mention.id)
  const mentionOpenId =
    asNonEmptyString(idRecord?.open_id) ||
    asNonEmptyString(mention.open_id) ||
    null
  const mentionUserId =
    asNonEmptyString(idRecord?.user_id) ||
    asNonEmptyString(mention.user_id) ||
    null
  const mentionAppId =
    asNonEmptyString(idRecord?.app_id) ||
    asNonEmptyString(mention.app_id) ||
    null
  const mentionName = asNonEmptyString(mention.name)

  if (state.botOpenId && mentionOpenId && mentionOpenId === state.botOpenId) return true
  if (state.botUserId && mentionUserId && mentionUserId === state.botUserId) return true
  if (state.appId && mentionAppId && mentionAppId === state.appId) return true

  const normalizedBotName = normalizeBotName(state.botName)
  if (
    normalizedBotName &&
    mentionName &&
    normalizeBotName(mentionName) === normalizedBotName
  ) {
    return true
  }
  return false
}

export function isGroupMessageAddressedToBot(
  message: { content: string },
  parsedContent: Record<string, unknown> | null,
  state: IdentityState,
): boolean {
  const messageRecord = asRecord(message)
  const messageMentionsRaw = messageRecord ? messageRecord.mentions : undefined
  const contentMentionsRaw = parsedContent ? parsedContent.mentions : undefined
  const messageMentions = Array.isArray(messageMentionsRaw) ? messageMentionsRaw : []
  const contentMentions = Array.isArray(contentMentionsRaw) ? contentMentionsRaw : []
  const mentionCandidates = [...messageMentions, ...contentMentions]
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))

  for (const mention of mentionCandidates) {
    if (isMentionMatchedToBot(mention, state)) {
      return true
    }
  }

  const text =
    asNonEmptyString(parsedContent?.text) ||
    asNonEmptyString(message.content) ||
    ''
  if (!text) return false
  if (!/<at\b/i.test(text)) return false

  if (state.botOpenId) {
    const openIdPattern = new RegExp(
      `<at[^>]*\\b(?:user_id|open_id|id)=["']${escapeRegExp(state.botOpenId)}["'][^>]*>`,
      'i',
    )
    if (openIdPattern.test(text)) return true
  }
  if (state.botUserId) {
    const userIdPattern = new RegExp(
      `<at[^>]*\\b(?:user_id|open_id|id)=["']${escapeRegExp(state.botUserId)}["'][^>]*>`,
      'i',
    )
    if (userIdPattern.test(text)) return true
  }
  if (state.appId) {
    const appIdPattern = new RegExp(
      `<at[^>]*\\bapp_id=["']${escapeRegExp(state.appId)}["'][^>]*>`,
      'i',
    )
    if (appIdPattern.test(text)) return true
  }

  const normalizedBN = normalizeBotName(state.botName)
  if (normalizedBN) {
    const plainTextNormalized = normalizeBotName(
      text.replace(/<[^>]+>/g, '').replace(/^@+/, ''),
    )
    if (plainTextNormalized.includes(normalizedBN)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Sender display name resolution
// ---------------------------------------------------------------------------

export function cacheSenderDisplayName(
  senderIds: SenderIds,
  displayName: string,
  state: IdentityState,
): void {
  const normalized = displayName.trim()
  if (!normalized) return
  if (senderIds.openId) state.senderDisplayNameById.set(senderIds.openId, normalized)
  if (senderIds.userId) state.senderDisplayNameById.set(senderIds.userId, normalized)
  if (senderIds.unionId) state.senderDisplayNameById.set(senderIds.unionId, normalized)
}

export function getCachedSenderDisplayName(
  senderIds: SenderIds,
  state: IdentityState,
): string | undefined {
  if (senderIds.openId) {
    const cached = state.senderDisplayNameById.get(senderIds.openId)
    if (cached) return cached
  }
  if (senderIds.userId) {
    const cached = state.senderDisplayNameById.get(senderIds.userId)
    if (cached) return cached
  }
  if (senderIds.unionId) {
    const cached = state.senderDisplayNameById.get(senderIds.unionId)
    if (cached) return cached
  }
  return undefined
}

export async function fetchAndCacheSenderDisplayName(
  senderIds: SenderIds,
  state: IdentityState,
): Promise<string | null> {
  if (state.contactProfileReadUnavailable) return null
  const candidate =
    (senderIds.openId && { id: senderIds.openId, type: 'open_id' as const }) ||
    (senderIds.userId && { id: senderIds.userId, type: 'user_id' as const }) ||
    (senderIds.unionId && { id: senderIds.unionId, type: 'union_id' as const }) ||
    null
  if (!candidate) return null

  const token = await fetchInternalAccessToken('tenant', state)
  if (!token) return null
  const baseUrl = getOpenApiBaseUrl(state)
  const encodedUserId = encodeURIComponent(candidate.id)

  try {
    const response = await requestJson(
      `${baseUrl}/open-apis/contact/v3/users/${encodedUserId}?user_id_type=${candidate.type}`,
      'GET',
      undefined,
      { Authorization: `Bearer ${token}` },
    )
    const data = asRecord(response.data) || response
    const user = asRecord(data.user) || data
    const name = asNonEmptyString(user.name)
    if (!name) return null
    cacheSenderDisplayName(senderIds, name, state)
    return name
  } catch (err) {
    const message = (err as Error)?.message || ''
    if (
      /Access denied/i.test(message) &&
      /(contact:user|contact:scope|contact\.|contact:)/i.test(message)
    ) {
      state.contactProfileReadUnavailable = true
      log.warn(
        'Feishu contact profile permission missing; senderName falls back to sender id.',
      )
      return null
    }
    log.warn('Feishu sender profile lookup failed:', sanitizeError(err))
    return null
  }
}

export async function resolveSenderDisplayName(
  rawEvent: Record<string, unknown>,
  senderIds: SenderIds,
  parsedContent: Record<string, unknown> | null,
  state: IdentityState,
): Promise<string | undefined> {
  const senderId = senderIds.openId || senderIds.userId || senderIds.unionId || ''
  const senderRecord = asRecord(rawEvent.sender)
  const fromSender =
    asNonEmptyString(senderRecord?.sender_name) ||
    asNonEmptyString(senderRecord?.name) ||
    asNonEmptyString((asRecord(senderRecord?.sender_id) || {}).name)
  if (fromSender) {
    cacheSenderDisplayName(senderIds, fromSender, state)
    return fromSender
  }

  const fromContent =
    asNonEmptyString(parsedContent?.sender_name) ||
    asNonEmptyString(parsedContent?.name)
  if (fromContent) {
    cacheSenderDisplayName(senderIds, fromContent, state)
    return fromContent
  }

  const cached = getCachedSenderDisplayName(senderIds, state)
  if (cached) return cached

  const fetched = await fetchAndCacheSenderDisplayName(senderIds, state)
  if (fetched) return fetched

  if (senderId) return senderId
  return undefined
}

// ---------------------------------------------------------------------------
// Bot name loading
// ---------------------------------------------------------------------------

export async function loadBotName(state: IdentityState): Promise<void> {
  if (!state.client || !state.appId) return
  let lastError: unknown
  const languages: Array<'zh_cn' | 'en_us'> = ['zh_cn', 'en_us']
  try {
    try {
      const botName = await loadBotNameViaBotInfo(state)
      if (botName) {
        state.botName = botName
        return
      }
    } catch (error) {
      lastError = error
    }

    for (const lang of languages) {
      try {
        const result = await state.client.application.application.get({
          params: { lang },
          path: { app_id: state.appId },
        })
        const appInfo = result?.data?.app
        const i18n = (appInfo as { i18n?: Array<{ name?: string }> })?.i18n
        const name =
          appInfo?.app_name?.trim() ||
          i18n?.find((item) => item.name?.trim())?.name?.trim()
        if (name) {
          state.botName = name
          return
        }
      } catch (error) {
        lastError = error
      }
    }

    for (const lang of languages) {
      try {
        const result = await state.client.application.applicationAppVersion.list({
          params: { lang, page_size: 1 },
          path: { app_id: state.appId },
        })
        const appVersion = result?.data?.items?.[0]
        const name = appVersion?.app_name?.trim()
        if (name) {
          state.botName = name
          return
        }
      } catch (error) {
        lastError = error
      }
    }

    if (lastError) {
      log.warn('Feishu bot name fetch failed:', sanitizeError(lastError))
    }
  } catch (error) {
    log.warn('Feishu bot name fetch failed:', sanitizeError(error))
  }
}

export async function loadBotNameViaBotInfo(state: IdentityState): Promise<string | null> {
  const tokens: Array<{ label: 'tenant' | 'app'; token: string }> = []

  const tenantToken = await fetchInternalAccessToken('tenant', state)
  if (tenantToken) tokens.push({ label: 'tenant', token: tenantToken })

  const appToken = await fetchInternalAccessToken('app', state)
  if (appToken) tokens.push({ label: 'app', token: appToken })

  let lastError: unknown
  for (const item of tokens) {
    try {
      const baseUrl = getOpenApiBaseUrl(state)
      const botInfo = await requestJson(
        `${baseUrl}/open-apis/bot/v3/info`,
        'GET',
        undefined,
        { Authorization: `Bearer ${item.token}` },
      )
      const bot =
        (botInfo.bot as Record<string, unknown> | undefined) ||
        (botInfo.data as Record<string, unknown> | undefined) ||
        botInfo
      const botOpenId =
        asNonEmptyString(bot.open_id) ||
        asNonEmptyString((asRecord(bot.id) || {}).open_id)
      if (botOpenId) {
        state.botOpenId = botOpenId
      }
      const botUserId =
        asNonEmptyString(bot.user_id) ||
        asNonEmptyString((asRecord(bot.id) || {}).user_id)
      if (botUserId) {
        state.botUserId = botUserId
      }
      const botName =
        (typeof bot.app_name === 'string' && bot.app_name.trim()) ||
        (typeof bot.name === 'string' && bot.name.trim())
      if (botName) return botName
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) throw lastError
  return null
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

export async function fetchInternalAccessToken(
  kind: 'tenant' | 'app',
  state: IdentityState,
): Promise<string | null> {
  if (!state.appId || !state.appSecret) return null

  const now = Date.now()
  const cached = state.tokenCache[kind]
  if (cached && cached.expiresAt > now + TOKEN_REFRESH_SKEW_MS) {
    return cached.token
  }

  const baseUrl = getOpenApiBaseUrl(state)
  const tokenPath =
    kind === 'tenant'
      ? '/open-apis/auth/v3/tenant_access_token/internal'
      : '/open-apis/auth/v3/app_access_token/internal'
  const res = await requestJson(`${baseUrl}${tokenPath}`, 'POST', {
    app_id: state.appId,
    app_secret: state.appSecret,
  })
  const tokenField = kind === 'tenant' ? 'tenant_access_token' : 'app_access_token'
  const token = res[tokenField]
  if (typeof token !== 'string' || !token.trim()) {
    return null
  }
  const expireRaw = res.expire
  const expireSeconds = typeof expireRaw === 'number' && expireRaw > 0 ? expireRaw : 60 * 60
  state.tokenCache[kind] = {
    token,
    expiresAt: Date.now() + expireSeconds * 1000,
  }
  return token
}

export function getOpenApiBaseUrl(state: IdentityState): string {
  if (state.client && typeof (state.client as { domain?: unknown }).domain === 'string') {
    return (state.client as { domain: string }).domain
  }
  return 'https://open.feishu.cn'
}

export function requestJson(
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8')
            if (!raw) return resolve({})
            const parsed = JSON.parse(raw) as Record<string, unknown>
            const code = typeof parsed.code === 'number' ? parsed.code : 0
            if (res.statusCode && res.statusCode >= 400) {
              return reject(
                new Error(
                  `HTTP ${res.statusCode}: ${String(parsed.msg || parsed.message || 'request failed')}`,
                ),
              )
            }
            if (code !== 0) {
              return reject(
                new Error(
                  `Feishu API error ${code}: ${String(parsed.msg || parsed.message || 'request failed')}`,
                ),
              )
            }
            resolve(parsed)
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}
