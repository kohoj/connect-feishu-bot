/**
 * Streaming entry point.
 *
 * One function, one purpose: turn a Lark SDK client into
 * a streaming card manager.
 */

import type { LarkClient, StreamingManager } from './types.js'
import { StreamingManagerImpl } from './manager.js'

export function createStreaming(client: LarkClient): StreamingManager {
  return new StreamingManagerImpl(client)
}

export type {
  LarkClient,
  StreamingManager,
  StreamingOptions,
  CompleteOptions,
} from './types.js'
