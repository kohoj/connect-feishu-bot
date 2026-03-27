/**
 * Throttled flush controller.
 *
 * A pure scheduling primitive — no business logic. The actual flush
 * work is provided via a callback. Manages timer-based throttling,
 * mutex-guarded flushing, and reflush-on-conflict.
 */

export class FlushController {
  private readonly doFlush: () => Promise<void>
  private flushInProgress = false
  private flushResolvers: Array<() => void> = []
  private needsReflush = false
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private lastFlushTime = 0
  private completed = false

  constructor(doFlush: () => Promise<void>) {
    this.doFlush = doFlush
  }

  /** Mark as completed — no more flushes after the current one. */
  complete(): void {
    this.completed = true
  }

  /** Cancel any pending deferred flush. */
  cancel(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }

  /** Wait for any in-progress flush to finish. */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) return Promise.resolve()
    return new Promise((resolve) => this.flushResolvers.push(resolve))
  }

  /**
   * Throttled entry point. Schedules a flush respecting the throttle
   * interval. If called while a flush is in-flight, sets needsReflush.
   */
  async scheduleFlush(throttleMs: number): Promise<void> {
    if (this.completed) return

    const now = Date.now()
    const elapsed = now - this.lastFlushTime

    if (elapsed >= throttleMs) {
      this.cancel()
      // After a long gap, batch briefly so the first visible update
      // contains meaningful text rather than 1-2 characters.
      if (elapsed > 2000) {
        this.lastFlushTime = now
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null
          void this.flush()
        }, 300)
      } else {
        await this.flush()
      }
    } else if (!this.pendingTimer) {
      const delay = throttleMs - elapsed
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null
        void this.flush()
      }, delay)
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async flush(): Promise<void> {
    if (this.flushInProgress || this.completed) {
      if (this.flushInProgress && !this.completed) this.needsReflush = true
      return
    }

    this.flushInProgress = true
    this.needsReflush = false
    this.lastFlushTime = Date.now()

    try {
      await this.doFlush()
      this.lastFlushTime = Date.now()
    } finally {
      this.flushInProgress = false

      const resolvers = this.flushResolvers
      this.flushResolvers = []
      for (const resolve of resolvers) resolve()

      // Events arrived while flush was in-flight — follow up immediately.
      if (this.needsReflush && !this.completed && !this.pendingTimer) {
        this.needsReflush = false
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null
          void this.flush()
        }, 0)
      }
    }
  }
}
