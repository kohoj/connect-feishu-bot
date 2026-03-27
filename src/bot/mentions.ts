/**
 * Mention resolution and caching — incoming + outgoing.
 *
 * Incoming: normalize @_user_N placeholders to display names.
 * Outgoing: convert @{name} syntax to <at> tags via chat member index.
 */
import { log } from '../log.js'
import type { MentionTarget, ParsedMentionTarget } from './types.js'
import {
  asRecord,
  asNonEmptyString,
  escapeXml,
  maskId,
  sanitizeError,
  CHAT_MENTION_CACHE_TTL_MS,
  MAX_CHAT_MENTION_CACHES,
} from './types.js'
import type { IdentityState } from './identity.js'
import {
  fetchInternalAccessToken,
  getOpenApiBaseUrl,
  requestJson,
} from './identity.js'

// ---------------------------------------------------------------------------
// Shared state shape (provided by FeishuBot)
// ---------------------------------------------------------------------------

export interface MentionState {
  chatMentionTargetByChatId: Map<string, Map<string, MentionTarget>>
  chatMentionCacheExpiresAtByChatId: Map<string, number>
  chatMemberReadUnavailable: boolean
}

// ---------------------------------------------------------------------------
// Lookup name normalization
// ---------------------------------------------------------------------------

export function normalizeMentionLookupName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^@+/, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .trim()
    .toLowerCase()
}

// ---------------------------------------------------------------------------
// Chat mention target map management
// ---------------------------------------------------------------------------

function getOrCreateChatMentionTargetMap(
  chatId: string,
  state: MentionState,
): Map<string, MentionTarget> {
  let map = state.chatMentionTargetByChatId.get(chatId)
  if (!map) {
    map = new Map<string, MentionTarget>()
    state.chatMentionTargetByChatId.set(chatId, map)
    pruneChatMentionCaches(state)
  }
  return map
}

function pruneChatMentionCaches(state: MentionState): void {
  while (state.chatMentionTargetByChatId.size > MAX_CHAT_MENTION_CACHES) {
    const oldestChatId = state.chatMentionTargetByChatId.keys().next().value
    if (oldestChatId === undefined) break
    state.chatMentionTargetByChatId.delete(oldestChatId)
    state.chatMentionCacheExpiresAtByChatId.delete(oldestChatId)
  }
}

export function cacheChatMentionTarget(
  chatId: string,
  displayName: string,
  target: { openId?: string; appId?: string },
  aliases: string[],
  state: MentionState,
): void {
  const normalizedName = normalizeMentionLookupName(displayName)
  const openId = asNonEmptyString(target.openId)
  const appId = asNonEmptyString(target.appId)
  if (!chatId || !normalizedName || (!openId && !appId)) return

  const map = getOrCreateChatMentionTargetMap(chatId, state)
  const normalizedAliases = Array.from(
    new Set(
      [displayName, ...aliases]
        .map((alias) => normalizeMentionLookupName(alias))
        .filter(Boolean),
    ),
  )
  const displayNameValue = displayName.trim() || displayName
  for (const alias of normalizedAliases) {
    const existing = map.get(alias)
    map.set(alias, {
      displayName: displayNameValue || existing?.displayName || alias,
      openId: openId || existing?.openId,
      appId: appId || existing?.appId,
    })
  }
}

// ---------------------------------------------------------------------------
// Mention parsing
// ---------------------------------------------------------------------------

export function parseMentionTarget(mention: unknown): ParsedMentionTarget | null {
  const record = asRecord(mention)
  if (!record) return null

  const idRecord = asRecord(record.id)
  const displayName =
    asNonEmptyString(record.name) ||
    asNonEmptyString(record.display_name) ||
    asNonEmptyString(record.user_name) ||
    asNonEmptyString(record.text)
  const mentionKey =
    asNonEmptyString(record.key) ||
    asNonEmptyString(record.mention_key) ||
    asNonEmptyString(record.token)
  const openId =
    asNonEmptyString(idRecord?.open_id) ||
    asNonEmptyString(idRecord?.user_id) ||
    asNonEmptyString(idRecord?.union_id) ||
    asNonEmptyString(record.open_id) ||
    asNonEmptyString(record.user_id) ||
    asNonEmptyString(record.union_id) ||
    null
  const appId =
    asNonEmptyString(idRecord?.app_id) ||
    asNonEmptyString(record.app_id) ||
    null

  if (!displayName || (!openId && !appId)) return null

  const aliases = Array.from(
    new Set(
      [
        displayName,
        mentionKey,
        mentionKey?.replace(/^@+/, ''),
        asNonEmptyString(record.text)?.replace(/^@+/, ''),
        openId,
        appId,
      ].filter((value): value is string => Boolean(value)),
    ),
  )

  return {
    displayName,
    ...(openId ? { openId } : {}),
    ...(appId ? { appId } : {}),
    aliases,
  }
}

export function cacheChatMentionTargetsFromRawMentions(
  chatId: string,
  rawMentions: unknown,
  state: MentionState,
): void {
  const mentions = Array.isArray(rawMentions) ? rawMentions : []
  for (const mention of mentions) {
    const parsed = parseMentionTarget(mention)
    if (!parsed) continue
    cacheChatMentionTarget(chatId, parsed.displayName, parsed, parsed.aliases, state)
  }
}

// ---------------------------------------------------------------------------
// Incoming mention normalization
// ---------------------------------------------------------------------------

export function normalizeIncomingMentionPlaceholders(
  text: string,
  rawMentions: unknown[],
): string {
  if (!text) return text
  const replacements: Array<{ key: string; value: string }> = []
  for (const mention of rawMentions) {
    const parsed = parseMentionTarget(mention)
    if (!parsed) continue
    const mentionLabel = `@${parsed.displayName.trim()}`
    for (const alias of parsed.aliases) {
      const normalizedAlias = alias.trim()
      if (!normalizedAlias) continue
      if (!/^@?_user_\d+$/i.test(normalizedAlias)) continue
      const key = normalizedAlias.startsWith('@') ? normalizedAlias : `@${normalizedAlias}`
      replacements.push({ key, value: mentionLabel })
    }
  }
  if (replacements.length === 0) return text

  let normalized = text
  const uniq = Array.from(
    new Map(
      replacements
        .sort((a, b) => b.key.length - a.key.length)
        .map((item) => [item.key, item.value] as const),
    ).entries(),
  )
  for (const [from, to] of uniq) {
    normalized = normalized.split(from).join(to)
  }
  return normalized
}

// ---------------------------------------------------------------------------
// Chat member refresh
// ---------------------------------------------------------------------------

export async function refreshChatMentionTargets(
  chatId: string,
  force: boolean,
  mentionState: MentionState,
  identityState: IdentityState,
): Promise<void> {
  if (!chatId || mentionState.chatMemberReadUnavailable) return
  const now = Date.now()
  const expiresAt = mentionState.chatMentionCacheExpiresAtByChatId.get(chatId) || 0
  if (!force && expiresAt > now) return

  const token = await fetchInternalAccessToken('tenant', identityState)
  if (!token) return
  const baseUrl = getOpenApiBaseUrl(identityState)
  const encodedChatId = encodeURIComponent(chatId)

  let pageToken: string | null = null
  for (let i = 0; i < 5; i++) {
    const query = new URLSearchParams({
      member_id_type: 'open_id',
      page_size: '100',
      ...(pageToken ? { page_token: pageToken } : {}),
    }).toString()
    let response: Record<string, unknown>
    try {
      response = await requestJson(
        `${baseUrl}/open-apis/im/v1/chats/${encodedChatId}/members?${query}`,
        'GET',
        undefined,
        { Authorization: `Bearer ${token}` },
      )
    } catch (err) {
      const message = (err as Error)?.message || ''
      if (
        /Access denied/i.test(message) &&
        /(im:chat:readonly|im:chat|im:message:readonly|im:message\.group)/i.test(message)
      ) {
        mentionState.chatMemberReadUnavailable = true
        log.warn(
          'Feishu chat member permission missing; skip member index for @mention conversion.',
        )
        return
      }
      log.warn('Feishu chat member lookup failed:', sanitizeError(err))
      mentionState.chatMentionCacheExpiresAtByChatId.set(chatId, now + 60 * 1000)
      return
    }

    const data = asRecord(response.data) || response
    const items = Array.isArray(data.items) ? data.items : []
    for (const item of items) {
      const row = asRecord(item)
      if (!row) continue
      const idRecord = asRecord(row.id)
      const memberOpenId =
        asNonEmptyString(row.member_id) ||
        asNonEmptyString(row.open_id) ||
        asNonEmptyString(idRecord?.open_id)
      const memberName =
        asNonEmptyString(row.name) ||
        asNonEmptyString(row.display_name) ||
        asNonEmptyString(row.user_name)
      if (!memberOpenId || !memberName) continue
      cacheChatMentionTarget(chatId, memberName, { openId: memberOpenId }, [], mentionState)
    }

    const hasMore = data.has_more === true || data.hasMore === true
    const nextPageToken =
      asNonEmptyString(data.page_token) || asNonEmptyString(data.pageToken)
    if (!hasMore || !nextPageToken) break
    pageToken = nextPageToken
  }

  mentionState.chatMentionCacheExpiresAtByChatId.set(
    chatId,
    Date.now() + CHAT_MENTION_CACHE_TTL_MS,
  )
}

// ---------------------------------------------------------------------------
// Mention target resolution by name
// ---------------------------------------------------------------------------

export function resolveMentionTargetByName(
  chatId: string,
  rawName: string,
  mentionState: MentionState,
  identityState: IdentityState,
): MentionTarget | null {
  const normalized = normalizeMentionLookupName(rawName)
  if (!normalized) return null
  if (normalized === 'all' || normalized === 'everyone' || normalized === '所有人') {
    return { displayName: '所有人', openId: 'all' }
  }

  const map = mentionState.chatMentionTargetByChatId.get(chatId)
  const direct = map?.get(normalized)
  if (direct) return direct

  if (map && normalized) {
    const scored = new Map<
      string,
      {
        target: MentionTarget
        score: number
      }
    >()
    for (const [alias, target] of map.entries()) {
      if (!alias) continue
      if (!alias.includes(normalized) && !normalized.includes(alias)) continue
      const targetKey = `${target.openId || ''}|${target.appId || ''}|${normalizeMentionLookupName(target.displayName)}`
      const score = Math.abs(alias.length - normalized.length)
      const existing = scored.get(targetKey)
      if (!existing || score < existing.score) {
        scored.set(targetKey, { target, score })
      }
    }
    const candidates = Array.from(scored.values()).sort((a, b) => a.score - b.score)
    if (candidates.length === 1) {
      return candidates[0].target
    }
    if (candidates.length > 1 && candidates[0].score < candidates[1].score) {
      return candidates[0].target
    }
  }

  if (identityState.botName) {
    const normalizedBotName = normalizeMentionLookupName(identityState.botName)
    if (normalizedBotName && normalized === normalizedBotName) {
      return {
        displayName: identityState.botName,
        ...(identityState.botOpenId ? { openId: identityState.botOpenId } : {}),
        ...(identityState.appId ? { appId: identityState.appId } : {}),
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Outgoing mention normalization
// ---------------------------------------------------------------------------

export async function normalizeOutgoingMentions(
  text: string,
  target: { receiveIdType: 'open_id' | 'chat_id'; receiveId: string },
  mentionState: MentionState,
  identityState: IdentityState,
): Promise<string> {
  if (!text || target.receiveIdType !== 'chat_id') return text
  const chatId = target.receiveId

  const primeMentionIndex = async (force: boolean = false) => {
    try {
      await refreshChatMentionTargets(chatId, force, mentionState, identityState)
    } catch (err) {
      log.warn('Feishu mention index refresh failed:', sanitizeError(err))
    }
    if (identityState.botName) {
      cacheChatMentionTarget(chatId, identityState.botName, {
        ...(identityState.botOpenId ? { openId: identityState.botOpenId } : {}),
        ...(identityState.appId ? { appId: identityState.appId } : {}),
      }, [], mentionState)
    }
  }
  await primeMentionIndex(false)

  const preservedAtTags: string[] = []
  const masked = text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, (matched) => {
    const token = `__FEISHU_BOT_AT_TAG_${preservedAtTags.length}__`
    preservedAtTags.push(matched)
    return token
  })

  const renderMentionTag = (rawName: string): string | null => {
    const mentionTarget = resolveMentionTargetByName(chatId, rawName, mentionState, identityState)
    if (!mentionTarget) return null
    if (mentionTarget.openId === 'all') {
      return '<at user_id="all">所有人</at>'
    }
    const safeName = escapeXml(mentionTarget.displayName || rawName)
    if (mentionTarget.openId) {
      return `<at user_id="${mentionTarget.openId}">${safeName}</at>`
    }
    if (mentionTarget.appId) {
      return `<at app_id="${mentionTarget.appId}">${safeName}</at>`
    }
    return null
  }

  const applyMentionReplacement = (
    source: string,
  ): { output: string; unresolvedBraceNames: Set<string> } => {
    const unresolvedBraceNames = new Set<string>()
    let output = source
    output = output.replace(/@\s*\{([^{}\n\r]{1,80})\}/g, (matched, name: string) => {
      const cleanName = name.trim()
      const mentionTag = renderMentionTag(cleanName)
      if (mentionTag) return mentionTag
      unresolvedBraceNames.add(cleanName)
      return matched
    })
    output = output.replace(
      /(^|[^A-Za-z0-9_@])@([^\s@<>{}\[\](),，。!！?？:：;；"""'''`~\\/]{1,40})/g,
      (matched, prefix: string, name: string) => {
        const mentionTag = renderMentionTag(name.trim())
        return mentionTag ? `${prefix}${mentionTag}` : matched
      },
    )
    return { output, unresolvedBraceNames }
  }

  let replacement = applyMentionReplacement(masked)
  if (replacement.unresolvedBraceNames.size > 0) {
    await primeMentionIndex(true)
    replacement = applyMentionReplacement(masked)
  }
  let normalized = replacement.output
  if (replacement.unresolvedBraceNames.size > 0) {
    const unresolvedPreview = Array.from(replacement.unresolvedBraceNames)
      .slice(0, 3)
      .join(', ')
    log.info(
      `Feishu mention unresolved after refresh: chat=${maskId(chatId)}, count=${replacement.unresolvedBraceNames.size}, names=${unresolvedPreview}`,
    )
    normalized = normalized.replace(
      /@\s*\{([^{}\n\r]{1,80})\}/g,
      (_matched, name: string) => {
        const cleanName = name.trim()
        return cleanName ? `@${cleanName}` : _matched
      },
    )
  }

  for (let i = 0; i < preservedAtTags.length; i++) {
    normalized = normalized.replace(`__FEISHU_BOT_AT_TAG_${i}__`, preservedAtTags[i])
  }
  return normalized
}
