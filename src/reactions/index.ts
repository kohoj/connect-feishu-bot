/**
 * Reactions entry point.
 *
 * Symmetric to streaming/index.ts — one factory, one purpose.
 */

import type { LarkReactionClient, ReactionsManager } from './types.js'
import { ReactionsManagerImpl } from './lifecycle.js'

export function createReactions(client: LarkReactionClient): ReactionsManager {
  return new ReactionsManagerImpl(client)
}

export type {
  LarkReactionClient,
  ReactionsManager,
  AcknowledgeOptions,
} from './types.js'
