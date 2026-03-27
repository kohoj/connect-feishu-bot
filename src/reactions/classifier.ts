/**
 * Message classifier — content to emoji.
 *
 * Seven emojis. A Pantone swatch, not a crayon box.
 *
 *   FINGERHEART   — casual warmth (greetings, affirmatives)
 *   THINKING      — contemplating a question
 *   OnIt          — accepting a task
 *   HEART         — receiving thanks
 *   StatusReading — reading long content or attachments
 *   Typing        — escalation at 5s (processing)
 *   STRIVE        — escalation at 15s (deep work)
 */

// Greetings + short affirmatives — same warmth, same emoji.
const CASUAL_RE =
  /^(hi|hello|hey|你好|嗨|哈喽|早|晚上好|早上好|在吗|在不在|好的?|ok|okay|嗯+|收到|明白|了解|知道了|对|是的|行|可以|没问题)[!！。~～]*$/i

const GRATITUDE_RE =
  /谢|感谢|thanks|thank you|太[棒好强]了|辛苦|nice|great|awesome|厉害|牛|666/i

const HELP_RE =
  /帮|help|请|能不能|可以.{0,4}吗|麻烦|assist/i

const QUESTION_RE =
  /[?？]|吗$|呢$|什么|怎么|为什么|how |what |why |where |when /i

export function classify(text: string, hasAttachment: boolean): string {
  const t = text.trim()

  if (!hasAttachment && t.length <= 12 && CASUAL_RE.test(t)) return 'FINGERHEART'
  if (GRATITUDE_RE.test(t)) return 'HEART'
  if (HELP_RE.test(t)) return 'OnIt'
  if (QUESTION_RE.test(t)) return 'THINKING'
  if (hasAttachment) return 'StatusReading'
  if (t.length > 200) return 'StatusReading'

  return 'THINKING'
}

export const ESCALATION_EMOJI = 'Typing'
export const DEEP_WORK_EMOJI = 'STRIVE'
