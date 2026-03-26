#!/usr/bin/env node

import { connectFeishuBot } from './registration.js'
import { validateCredentials } from './validate.js'

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const verbose = args.includes('--verbose')
const helpFlag = args.includes('--help') || args.includes('-h')
const versionFlag = args.includes('--version') || args.includes('-v')

const validateIdx = args.indexOf('--validate')
const validateArg = validateIdx !== -1 ? args[validateIdx + 1] : undefined

function mask(secret: string): string {
  if (secret.length <= 8) return '*'.repeat(secret.length)
  return secret.slice(0, 4) + '*'.repeat(secret.length - 8) + secret.slice(-4)
}

async function printVersion() {
  // Dynamic import to read package.json version
  const { createRequire } = await import('module')
  const require = createRequire(import.meta.url)
  try {
    const pkg = require('../package.json')
    console.log(pkg.version)
  } catch {
    console.log('unknown')
  }
}

function printHelp() {
  console.log(`
connect-feishu-bot — Create a Feishu/Lark bot by scanning a QR code.
扫码一键创建飞书机器人。

Usage:
  npx connect-feishu-bot [options]

Options:
  --json                       Output result as JSON
  --validate <appId:appSecret> Validate existing credentials
  --verbose                    Show QR code URL text
  --timeout <seconds>          QR code expiry (default: 600)
  --help, -h                   Show this help
  --version, -v                Show version

Examples:
  npx connect-feishu-bot
  npx connect-feishu-bot --json
  npx connect-feishu-bot --validate cli_xxx:secret_xxx
`)
}

async function handleValidate(credential: string) {
  const colonIdx = credential.indexOf(':')
  if (colonIdx === -1 || colonIdx === 0 || colonIdx === credential.length - 1) {
    console.error('Error: Format must be appId:appSecret')
    process.exit(1)
  }

  const appId = credential.slice(0, colonIdx)
  const appSecret = credential.slice(colonIdx + 1)

  const valid = await validateCredentials(appId, appSecret)

  if (jsonMode) {
    console.log(JSON.stringify({ appId, valid }))
  } else if (valid) {
    console.log(`\u2713 Credentials valid for ${appId}`)
  } else {
    console.error(`\u2717 Invalid credentials for ${appId}`)
    process.exit(1)
  }
}

async function handleConnect() {
  // Dynamically import qrcode-terminal only in CLI mode
  let renderQR: ((url: string) => void) | undefined
  try {
    const qrcode = await import('qrcode-terminal')
    renderQR = (url: string) => {
      qrcode.generate(url, { small: true })
    }
  } catch {
    // qrcode-terminal not available — print URL only
  }

  try {
    const result = await connectFeishuBot({
      onQRCode: (url) => {
        if (!jsonMode) {
          console.log(
            '\n  Scan with Feishu to create your bot (请使用飞书扫码，创建机器人):\n',
          )
          if (renderQR) {
            renderQR(url)
          } else {
            console.log(`  ${url}`)
          }
          if (verbose) {
            console.log(`\n  URL: ${url}`)
          }
          console.log()
        }
      },
      onStatus: (status) => {
        if (jsonMode) return
        switch (status.phase) {
          case 'initializing':
            process.stdout.write('  Initializing...\r')
            break
          case 'waiting_for_scan':
            process.stdout.write('  Waiting for scan...\r')
            break
          case 'denied':
            console.error('\n  \u2717 Authorization denied by user')
            break
          case 'expired':
            console.error('\n  \u2717 QR code expired. Please try again.')
            break
          case 'error':
            console.error(`\n  \u2717 Error: ${status.message}`)
            break
        }
      },
    })

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`\n  \u2713 Bot created! (机器人创建成功!)\n`)
      console.log(`  App ID:     ${result.appId}`)
      console.log(`  App Secret: ${mask(result.appSecret)}`)
      if (result.userOpenId) {
        console.log(`  User:       ${result.userOpenId}`)
      }
      console.log(`  Domain:     ${result.domain}`)
      console.log(`\n  Done! Your bot is ready to use.\n`)
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (!jsonMode) console.error('\n  Cancelled.')
      process.exit(130)
    }

    const message = err instanceof Error ? err.message : String(err)
    if (jsonMode) {
      console.error(JSON.stringify({ error: message }))
    } else {
      console.error(`\n  Error: ${message}`)
    }
    process.exit(1)
  }
}

async function main() {
  if (helpFlag) {
    printHelp()
    return
  }

  if (versionFlag) {
    await printVersion()
    return
  }

  if (validateArg) {
    await handleValidate(validateArg)
    return
  }

  await handleConnect()
}

main()
