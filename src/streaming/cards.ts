/**
 * Card JSON builders for Feishu CardKit 2.0 streaming.
 *
 * Three states, each as deliberate as a Wes Anderson frame:
 *   thinking  — empty canvas, breathing loading icon
 *   complete  — full text, optional elapsed footer
 *   fallback  — non-CardKit interactive card for IM patch mode
 */

export const STREAMING_ELEMENT_ID = 'streaming_content'
const LOADING_ELEMENT_ID = 'loading'

// ---------------------------------------------------------------------------
// Thinking — the moment before the first word
// ---------------------------------------------------------------------------

export function thinkingCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: 'Thinking...' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          text_align: 'left',
          text_size: 'normal_v2',
          element_id: STREAMING_ELEMENT_ID,
        },
        {
          tag: 'markdown',
          content: ' ',
          icon: {
            tag: 'standard_icon',
            token: 'loading_outlined',
            size: '16px 16px',
          },
          element_id: LOADING_ELEMENT_ID,
        },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Complete — the final frame, everything in its right place
// ---------------------------------------------------------------------------

export function completeCard(
  text: string,
  options?: { elapsed?: number },
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: text || 'Done.',
      text_align: 'left',
      text_size: 'normal_v2',
    },
  ]

  if (options?.elapsed != null) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `⏱ ${formatElapsed(options.elapsed)}`,
        text_size: 'notation',
      },
    )
  }

  return {
    schema: '2.0',
    body: { elements },
  }
}

// ---------------------------------------------------------------------------
// Fallback — interactive card for IM patch mode (no CardKit)
// ---------------------------------------------------------------------------

export function fallbackThinkingCard(): Record<string, unknown> {
  return {
    config: { update_multi: true },
    elements: [
      {
        tag: 'div',
        text: { tag: 'plain_text', content: 'Thinking...' },
      },
    ],
  }
}

export function fallbackStreamingCard(text: string): Record<string, unknown> {
  return {
    config: { update_multi: true },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: text || 'Thinking...' },
      },
    ],
  }
}

export function fallbackCompleteCard(
  text: string,
  options?: { elapsed?: number },
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: text || 'Done.' },
    },
  ]

  if (options?.elapsed != null) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `⏱ ${formatElapsed(options.elapsed)}`,
        },
      },
    )
  }

  return { config: { update_multi: true }, elements }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}
