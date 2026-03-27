/**
 * WebSocket event handler — message parsing, file download, event dispatch.
 */
import { log } from '../log.js'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuBotOptions, IncomingMessage } from './types.js'
import {
  asRecord,
  asNonEmptyString,
  maskId,
  sanitizeError,
  withRetry,
} from './types.js'
import type { IdentityState } from './identity.js'
import {
  isGroupMessageAddressedToBot,
  resolveSenderDisplayName,
} from './identity.js'
import type { MentionState } from './mentions.js'
import {
  normalizeIncomingMentionPlaceholders,
  cacheChatMentionTarget,
  cacheChatMentionTargetsFromRawMentions,
} from './mentions.js'

// ---------------------------------------------------------------------------
// Message event handling
// ---------------------------------------------------------------------------

export async function handleMessageEvent(
  data: Record<string, unknown>,
  client: lark.Client,
  identityState: IdentityState,
  mentionState: MentionState,
  opts: FeishuBotOptions,
): Promise<void> {
  const event = data as {
    message: {
      message_id: string
      chat_id: string
      chat_type: string
      message_type: string
      content: string
      create_time: string
      mentions?: unknown[]
    }
    sender: {
      sender_id: {
        open_id?: string
        user_id?: string
        union_id?: string
        app_id?: string
      }
      sender_type?: string
    }
  }

  const { message, sender } = event
  const senderOpenId = sender?.sender_id?.open_id
  const senderUserId = sender?.sender_id?.user_id
  const senderUnionId = sender?.sender_id?.union_id
  const senderAppId = sender?.sender_id?.app_id
  const senderId = senderOpenId || senderUserId || senderUnionId || senderAppId || ''
  const senderType = typeof sender?.sender_type === 'string' ? sender.sender_type.trim() : ''
  const normalizedSenderType = senderType.toLowerCase()
  const isUserSender = normalizedSenderType === 'user'
  const isBotLikeSender =
    normalizedSenderType === 'bot' ||
    normalizedSenderType === 'app' ||
    normalizedSenderType === 'application'
  const isP2PChat = message.chat_type === 'p2p'

  log.info(
    `Feishu incoming message: sender=${maskId(senderId || message.chat_id)} chatType=${message.chat_type} msgType=${message.message_type} msgId=${message.message_id}`,
  )

  if (senderType && !isUserSender && !isBotLikeSender) {
    log.info(`Feishu ignored unsupported sender type: ${senderType}`)
    return
  }
  if (isP2PChat && !isUserSender) {
    log.info(`Feishu ignored non-user p2p sender: ${senderType || 'unknown'}`)
    return
  }

  // Avoid self-trigger loops
  const fromSelf =
    (identityState.botOpenId && senderOpenId && senderOpenId === identityState.botOpenId) ||
    (identityState.botUserId && senderUserId && senderUserId === identityState.botUserId) ||
    (identityState.appId && senderAppId && senderAppId === identityState.appId)
  if (fromSelf) {
    log.info(`Feishu ignored self-originated message: sender=${maskId(senderId)}`)
    return
  }

  const downloadDir = opts.downloadDir || os.tmpdir()

  let text = ''
  let parsedContent: Record<string, unknown> | null = null
  const attachmentPaths: string[] = []

  try {
    const content = JSON.parse(message.content) as Record<string, unknown>
    parsedContent = content

    if (message.message_type === 'text') {
      text = asNonEmptyString(content.text) || ''
    } else if (message.message_type === 'post') {
      text = await parsePostContent(content, message, client, downloadDir, attachmentPaths)
    } else {
      const result = await parseMediaContent(
        content,
        message,
        client,
        downloadDir,
      )
      text = result.text
      attachmentPaths.push(...result.attachments)
    }
  } catch {
    text = message.content
  }

  if (text) {
    const messageMentions = Array.isArray(message.mentions) ? message.mentions : []
    const contentMentions =
      parsedContent && Array.isArray(parsedContent.mentions)
        ? parsedContent.mentions
        : []
    text = normalizeIncomingMentionPlaceholders(text, [
      ...messageMentions,
      ...contentMentions,
    ])
  }

  if (!text && attachmentPaths.length === 0) return

  if (!isP2PChat && !isGroupMessageAddressedToBot(message, parsedContent, identityState)) {
    log.info(
      `Feishu group message ignored (bot not @mentioned): chatId=${maskId(message.chat_id)}`,
    )
    return
  }

  const senderIds = {
    ...(senderOpenId ? { openId: senderOpenId } : {}),
    ...(senderUserId ? { userId: senderUserId } : {}),
    ...(senderUnionId ? { unionId: senderUnionId } : {}),
  }

  const senderName = await resolveSenderDisplayName(
    data,
    senderIds,
    parsedContent,
    identityState,
  )

  if (!isP2PChat) {
    const senderMentionId = senderOpenId || senderUserId || senderUnionId
    if (senderName && (senderMentionId || senderAppId)) {
      cacheChatMentionTarget(message.chat_id, senderName, {
        ...(senderMentionId ? { openId: senderMentionId } : {}),
        ...(senderAppId ? { appId: senderAppId } : {}),
      }, [], mentionState)
    }
    cacheChatMentionTargetsFromRawMentions(message.chat_id, message.mentions, mentionState)
    cacheChatMentionTargetsFromRawMentions(message.chat_id, parsedContent?.mentions, mentionState)
  }

  const chatId = isP2PChat ? senderId : message.chat_id
  const chatType = isP2PChat ? 'p2p' as const : 'group' as const

  const incoming: IncomingMessage = {
    messageId: message.message_id,
    chatId,
    chatType,
    senderId,
    senderName,
    text,
    attachments: attachmentPaths,
    messageType: message.message_type,
    mentions: message.mentions,
    parsedContent: parsedContent ?? undefined,
  }

  opts.onMessage(incoming)
}

// ---------------------------------------------------------------------------
// Post content parsing
// ---------------------------------------------------------------------------

async function parsePostContent(
  content: Record<string, unknown>,
  message: { message_id: string; content: string },
  client: lark.Client,
  downloadDir: string,
  attachmentPaths: string[],
): Promise<string> {
  let postBody: { title?: string; content?: unknown[][] } | undefined
  if (Array.isArray(content.content)) {
    postBody = content as { title?: string; content: unknown[][] }
  } else {
    const postRoot = (content.post ?? content) as Record<string, unknown>
    postBody = (postRoot.zh_cn ||
      postRoot.en_us ||
      Object.values(postRoot).find(
        (v) =>
          v &&
          typeof v === 'object' &&
          'content' in (v as Record<string, unknown>),
      )) as { title?: string; content?: unknown[][] } | undefined
  }

  if (postBody && Array.isArray(postBody.content)) {
    const textParts: string[] = []
    if (postBody.title) textParts.push(postBody.title)

    for (const paragraph of postBody.content) {
      if (!Array.isArray(paragraph)) continue
      for (const element of paragraph as Array<Record<string, string>>) {
        if (element.tag === 'text') {
          textParts.push(element.text || '')
        } else if (element.tag === 'img' && element.image_key) {
          const localPath = await downloadResource(
            client,
            message.message_id,
            element.image_key,
            'image',
            `image_${element.image_key}.png`,
            downloadDir,
          )
          if (localPath) attachmentPaths.push(localPath)
        } else if (element.tag === 'media' && element.file_key) {
          const localPath = await downloadResource(
            client,
            message.message_id,
            element.file_key,
            'file',
            `media_${element.file_key}.mp4`,
            downloadDir,
          )
          if (localPath) attachmentPaths.push(localPath)
        } else if (element.tag === 'at') {
          if (element.user_name) textParts.push(`@${element.user_name}`)
        } else if (element.tag === 'a') {
          textParts.push(element.text || element.href || '')
        } else if (element.tag === 'code_block') {
          textParts.push(element.text || '')
        }
      }
      textParts.push('\n')
    }
    return textParts.join('').trim()
  }

  return message.content
}

// ---------------------------------------------------------------------------
// Media content parsing (image, file, audio, media, sticker, fallback)
// ---------------------------------------------------------------------------

async function parseMediaContent(
  content: Record<string, unknown>,
  message: { message_id: string; message_type: string; content: string },
  client: lark.Client,
  downloadDir: string,
): Promise<{ text: string; attachments: string[] }> {
  const imageKey = asNonEmptyString(content.image_key)
  const fileKey = asNonEmptyString(content.file_key)
  const fileNameRaw = asNonEmptyString(content.file_name)
  const attachments: string[] = []
  let text = ''

  if (message.message_type === 'image' && imageKey) {
    const localPath = await downloadResource(
      client,
      message.message_id,
      imageKey,
      'image',
      `image_${imageKey}.png`,
      downloadDir,
    )
    if (localPath) {
      attachments.push(localPath)
    } else {
      text = '[User sent an image, but download failed]'
    }
  } else if (message.message_type === 'file' && fileKey) {
    const fileName = fileNameRaw || `file_${fileKey}`
    const localPath = await downloadResource(
      client,
      message.message_id,
      fileKey,
      'file',
      fileName,
      downloadDir,
    )
    if (localPath) {
      attachments.push(localPath)
    } else {
      text = `[User sent a file "${fileName}", but download failed]`
    }
  } else if (message.message_type === 'audio' && fileKey) {
    const localPath = await downloadResource(
      client,
      message.message_id,
      fileKey,
      'file',
      `audio_${fileKey}.opus`,
      downloadDir,
    )
    if (localPath) {
      attachments.push(localPath)
    } else {
      text = '[User sent an audio message, but download failed]'
    }
  } else if (message.message_type === 'media' && fileKey) {
    const localPath = await downloadResource(
      client,
      message.message_id,
      fileKey,
      'file',
      `media_${fileKey}.mp4`,
      downloadDir,
    )
    if (localPath) {
      attachments.push(localPath)
    } else {
      text = '[User sent a video, but download failed]'
    }
  } else if (message.message_type === 'sticker' && fileKey) {
    const localPath = await downloadResource(
      client,
      message.message_id,
      fileKey,
      'image',
      `sticker_${fileKey}.png`,
      downloadDir,
    )
    if (localPath) {
      attachments.push(localPath)
    } else {
      text = '[User sent a sticker, but download failed]'
    }
  } else {
    text = asNonEmptyString(content.text) || message.content
  }

  return { text, attachments }
}

// ---------------------------------------------------------------------------
// Resource download
// ---------------------------------------------------------------------------

export async function downloadResource(
  client: lark.Client,
  messageId: string,
  fileKey: string,
  resourceType: string,
  suggestedName: string,
  downloadDir: string,
): Promise<string | null> {
  fs.mkdirSync(downloadDir, { recursive: true })
  const localPath = path.join(downloadDir, `${Date.now()}_${suggestedName}`)

  const label = `Feishu ${resourceType} download`
  try {
    await withRetry(async () => {
      await fsp.unlink(localPath).catch(() => {})
      const resp = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType },
      })
      await resp.writeFile(localPath)
    }, label)
    log.info(`Feishu file downloaded: ${localPath}`)
    return localPath
  } catch (err) {
    log.warn(`${label} failed:`, sanitizeError(err))
    return null
  }
}
