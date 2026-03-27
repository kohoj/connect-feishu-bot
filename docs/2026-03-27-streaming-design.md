# CardKit Streaming — Design Spec

## Overview

Add real-time streaming card responses to `connect-feishu-bot` using Feishu's CardKit 2.0 API. When a bot generates a response, users see text appear character-by-character with a typewriter animation — replacing the dead silence of "no typing indicator."

Inspired by `@larksuite/openclaw-lark`'s streaming card controller.

## API

```typescript
import * as lark from '@larksuiteoapi/node-sdk'
import { createStreaming } from 'connect-feishu-bot'

const client = new lark.Client({ appId, appSecret })
const streaming = createStreaming(client)

await streaming.update(chatId, sessionId, 'Hello ')
await streaming.update(chatId, sessionId, 'Hello world!')
await streaming.complete(chatId, sessionId, { elapsed: 2400 })
```

### `createStreaming(client): StreamingManager`

Factory. Accepts a `@larksuiteoapi/node-sdk` Client instance.

### `manager.update(chatId, sessionId, text, options?)`

- First call: creates CardKit card entity → sends "Thinking..." message
- Subsequent calls: streams accumulated text via `cardElement.content()` (100ms throttle)
- `sessionId`: any number or string identifying this streaming session
- `options.replyTo`: reply to a specific message ID
- `options.replyInThread`: reply within a thread

### `manager.complete(chatId, sessionId, options?)`

- Closes streaming mode
- Updates card to final state (optional elapsed time footer)
- Removes session from internal map

### `manager.abort(chatId, sessionId)`

- Same as complete, but partial text is preserved with "Aborted" indicator

### `manager.dispose()`

- Aborts all active sessions, clears internal state

## Internal Architecture

### CardSession — State Machine

```
idle → creating → streaming → completed
                            → aborted
```

Each session holds: cardId, messageId, sequence counter, accumulated text, flush controller, fallback flag.

### FlushController — Throttled Updates

- CardKit mode: 100ms between flushes
- IM patch fallback: 1500ms (rate limit code 230020)
- Mutex-guarded: if a flush is in-flight, subsequent calls set `needsReflush` flag
- Long gap batching: after 2s idle, defer first flush 300ms to accumulate meaningful text

### Fallback Strategy

If `cardkit.v1.card.create()` fails (e.g., missing permission):
1. Fall back to `im.message.create` with interactive card
2. Update via `im.message.patch` at 1500ms throttle
3. API unchanged — consumer doesn't notice

### CardKit API Sequence

```
1. cardkit.v1.card.create({ streaming_mode: true })  → cardId
2. im.message.create({ card_id: cardId })             → messageId
3. cardkit.v1.cardElement.content(text, seq++)         → typewriter animation (repeated)
4. cardkit.v1.card.settings({ streaming_mode: false }) → close streaming
5. cardkit.v1.card.update(finalCard, seq++)            → terminal card state
```

## Card Design

### Thinking State

```json
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true,
    "summary": { "content": "Thinking..." }
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "", "element_id": "streaming_content", "text_size": "normal_v2" },
      { "tag": "markdown", "content": " ", "icon": { "tag": "standard_icon", "token": "loading_outlined", "size": "16px 16px" }, "element_id": "loading" }
    ]
  }
}
```

### Complete State

Loading icon removed. Optional elapsed footer in `notation` size.

## File Structure

```
src/
├── index.ts              # + export { createStreaming }
├── types.ts              # + StreamingOptions, CompleteOptions, StreamingManager
├── streaming/
│   ├── index.ts          # createStreaming() factory
│   ├── manager.ts        # StreamingManager — session routing
│   ├── session.ts        # CardSession — lifecycle state machine
│   ├── flush.ts          # FlushController — throttled scheduling
│   └── cards.ts          # Card JSON builders
├── registration.ts       # unchanged
├── validate.ts           # unchanged
├── cli.ts                # unchanged
└── vendor.d.ts           # unchanged
```

## Dependencies

- `@larksuiteoapi/node-sdk` as **peer dependency** (consumer provides it)
- No new production dependencies

## Package Exports

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./streaming": { "types": "./dist/streaming/index.d.ts", "import": "./dist/streaming/index.js" }
  }
}
```

Both `connect-feishu-bot` (main) and `connect-feishu-bot/streaming` (direct) work.
