/**
 * Package-level logger.
 *
 * Silent by default. Call `setLogger()` to enable output.
 * The FeishuBot constructor calls this with `opts.logger`.
 */

import type { Logger } from './bot/types.js'
import { nullLogger } from './bot/types.js'

let current: Logger = nullLogger

export function setLogger(logger: Logger | undefined): void {
  current = logger ?? nullLogger
}

export const log: Logger = {
  info: (msg, ...args) => current.info(msg, ...args),
  warn: (msg, ...args) => current.warn(msg, ...args),
}
