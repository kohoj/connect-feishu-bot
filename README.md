# connect-feishu-bot

Scan a QR code with Feishu to create and connect a bot in seconds. No manual app creation, no permission configuration, no admin approval.

**扫码一键创建飞书机器人。无需手动建应用、配权限、等审批。**

## Before vs After

| | Before | After |
|--|--------|-------|
| Steps | 9 (create app on FOP, configure 5 permissions, publish, wait for admin approval, enter credentials, configure event subscriptions, add events, publish again, wait for admin approval again) | **1** (scan QR code) |
| FOP operations | Manual throughout | None |
| Admin approvals | 2 rounds | 0 |
| Time | 15-30 minutes | < 1 minute |

## Install

```bash
# Run directly (no install needed)
npx connect-feishu-bot

# Or install globally
npm install -g connect-feishu-bot

# Or add to your project
npm install connect-feishu-bot
```

## CLI Usage

### Create a new bot

```bash
npx connect-feishu-bot
```

A QR code will appear in your terminal. Scan it with the Feishu mobile app. That's it.

```
$ npx connect-feishu-bot

  Scan with Feishu to create your bot (请使用飞书扫码，创建机器人):

  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ █ ▄▄ █ ▄▄▄ █
  █ █   █ █▄█ ▄█ █▄█ █
  █ █▄▄▄█ █ ▄▄▄█▄▄▄▄ █
  ...

  Waiting for scan...

  ✓ Bot created! (机器人创建成功!)

  App ID:     cli_a93xxxxxxxxxxxx
  App Secret: ********************************

  Done! Your bot is ready to use.
```

### JSON output

For scripting or piping into other tools:

```bash
npx connect-feishu-bot --json
```

```json
{
  "appId": "cli_a93xxxxxxxxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "userOpenId": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "domain": "feishu"
}
```

### Validate existing credentials

```bash
npx connect-feishu-bot --validate cli_a93xxxxxxxxxxxx:your_app_secret
```

### Options

| Flag | Description |
|------|-------------|
| `--json` | Output result as JSON |
| `--validate <appId:appSecret>` | Validate existing credentials |
| `--timeout <seconds>` | QR code expiry timeout (default: 600) |
| `--verbose` | Show QR code URL in addition to QR code |
| `--help` | Show help |
| `--version` | Show version |

## Programmatic API

### `connectFeishuBot(options?): Promise<ConnectResult>`

Create a new Feishu bot via QR code scanning.

```typescript
import { connectFeishuBot } from 'connect-feishu-bot'

const result = await connectFeishuBot({
  onQRCode: (url) => {
    // Display the QR code in your UI
    console.log('Scan this URL:', url)
  },
  onStatus: (status) => {
    switch (status.phase) {
      case 'waiting_for_scan':
        console.log('Please scan the QR code...')
        break
      case 'success':
        console.log('Bot created:', status.appId)
        break
      case 'expired':
        console.log('QR code expired')
        break
    }
  },
})

console.log(result.appId)     // "cli_a93xxxxxxxxxxxx"
console.log(result.appSecret) // "xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
console.log(result.domain)    // "feishu" or "lark"
```

#### Options

```typescript
interface ConnectOptions {
  /** Called when the QR code URL is ready. Display it to the user. */
  onQRCode?: (url: string) => void

  /** Called on status changes during the registration flow. */
  onStatus?: (status: RegistrationStatus) => void

  /** AbortSignal to cancel the registration flow. */
  signal?: AbortSignal

  /** API environment. Default: 'prod' */
  env?: 'prod' | 'boe' | 'pre'
}
```

#### Return value

```typescript
interface ConnectResult {
  /** The App ID of the newly created bot (e.g. "cli_a93xxxxxxxxxxxx") */
  appId: string

  /** The App Secret of the newly created bot */
  appSecret: string

  /** The open_id of the user who scanned the QR code */
  userOpenId?: string

  /** Whether this is a Feishu (China) or Lark (International) bot */
  domain: 'feishu' | 'lark'
}
```

#### Status events

```typescript
type RegistrationStatus =
  | { phase: 'initializing' }
  | { phase: 'waiting_for_scan'; qrUrl: string; expiresIn: number }
  | { phase: 'success'; appId: string; appSecret: string; userOpenId?: string; domain: 'feishu' | 'lark' }
  | { phase: 'denied' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string }
```

### `validateCredentials(appId, appSecret): Promise<boolean>`

Check whether an App ID and App Secret pair is valid.

```typescript
import { validateCredentials } from 'connect-feishu-bot'

const valid = await validateCredentials('cli_a93xxxxxxxxxxxx', 'your_app_secret')
console.log(valid) // true or false
```

### Cancellation

Use an `AbortSignal` to cancel the QR code flow:

```typescript
const controller = new AbortController()

// Cancel after 60 seconds
setTimeout(() => controller.abort(), 60_000)

try {
  const result = await connectFeishuBot({
    signal: controller.signal,
    onQRCode: (url) => renderQR(url),
  })
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('Cancelled by user')
  }
}
```

## Integration Examples

### Electron app

Show the QR code in a BrowserWindow:

```typescript
import { connectFeishuBot } from 'connect-feishu-bot'
import QRCode from 'qrcode' // or any QR renderer

ipcMain.handle('feishu:connect', async () => {
  const result = await connectFeishuBot({
    onQRCode: (url) => {
      // Send QR code URL to renderer for display
      mainWindow.webContents.send('feishu:qrcode', url)
    },
    onStatus: (status) => {
      mainWindow.webContents.send('feishu:status', status)
    },
  })
  return result
})
```

### React component

```tsx
import { connectFeishuBot } from 'connect-feishu-bot'
import { QRCodeSVG } from 'qrcode.react'

function FeishuConnect() {
  const [qrUrl, setQrUrl] = useState<string>()
  const [status, setStatus] = useState<string>('idle')

  const connect = async () => {
    const result = await connectFeishuBot({
      onQRCode: setQrUrl,
      onStatus: (s) => setStatus(s.phase),
    })
    // Use result.appId and result.appSecret
  }

  return (
    <div>
      <button onClick={connect}>Connect Feishu</button>
      {qrUrl && <QRCodeSVG value={qrUrl} />}
      <p>Status: {status}</p>
    </div>
  )
}
```

### Claude Code / AI agent

```bash
npx connect-feishu-bot --json | jq '.appId'
```

Or in a setup script:

```bash
#!/bin/bash
RESULT=$(npx connect-feishu-bot --json)
export FEISHU_APP_ID=$(echo "$RESULT" | jq -r '.appId')
export FEISHU_APP_SECRET=$(echo "$RESULT" | jq -r '.appSecret')
echo "Feishu bot connected: $FEISHU_APP_ID"
```

## How It Works

This package uses Feishu's device-code-style app registration API:

```
POST https://accounts.feishu.cn/oauth/v1/app/registration

Step 1: action=init
  → Returns supported auth methods

Step 2: action=begin, archetype=PersonalAgent
  → Returns QR code URL + device_code

Step 3: action=poll, device_code=xxx (repeated)
  → Returns appId + appSecret on scan
```

The `archetype=PersonalAgent` creates a lightweight bot that comes pre-configured with the necessary permissions. No manual setup on the Feishu Open Platform is required.

Feishu (China) and Lark (International) are both supported. The domain is auto-detected based on the scanning user's tenant.

## Requirements

- Node.js >= 18 (uses native `fetch`)
- A Feishu or Lark account with the mobile app installed

## Security

- **No credentials are stored** by this package. The caller decides how to persist them.
- **App Secrets are never logged.** The CLI masks them with `*` characters.
- **`validateCredentials` only returns boolean.** No token or secret is exposed.

## Feishu vs Lark

| | Feishu (飞书) | Lark |
|--|--------------|------|
| Region | China | International |
| API endpoint | `accounts.feishu.cn` | `accounts.larksuite.com` |
| Auto-detected | Yes | Yes |

Both are fully supported. The domain is detected automatically when the user scans the QR code.

## Troubleshooting

### QR code not scanning

- Ensure you're using the **Feishu mobile app** (not a generic QR scanner)
- Check your network connection
- Try `--verbose` to get the raw URL and open it manually

### "authorization_pending" timeout

The QR code expires after 10 minutes by default. Re-run the command to get a fresh code.

### Credentials validation fails

- Double-check the App ID starts with `cli_`
- Ensure the App Secret has no extra whitespace
- The bot may have been deleted on Feishu's side

## License

MIT
