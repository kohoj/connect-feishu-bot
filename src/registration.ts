import type {
  ConnectOptions,
  ConnectResult,
  RegistrationStatus,
  InitResponse,
  BeginResponse,
  PollResponse,
} from './types.js'

const FEISHU_URLS: Record<string, string> = {
  prod: 'https://accounts.feishu.cn',
  boe: 'https://accounts.feishu-boe.cn',
  pre: 'https://accounts.feishu-pre.cn',
}

const LARK_URLS: Record<string, string> = {
  prod: 'https://accounts.larksuite.com',
  boe: 'https://accounts.larksuite-boe.com',
  pre: 'https://accounts.larksuite-pre.com',
}

const ENDPOINT = '/oauth/v1/app/registration'
const DEFAULT_TIMEOUT_MS = 10_000
const RETRY_ATTEMPTS = 3
const RETRY_BASE_MS = 1000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

function createRequestSignal(parent?: AbortSignal): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  const abortFromParent = () => {
    controller.abort(parent?.reason)
  }

  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason)
    } else {
      parent.addEventListener('abort', abortFromParent, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

async function post<T>(
  baseUrl: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    signal?.throwIfAborted()
    const request = createRequestSignal(signal)

    try {
      const res = await fetch(`${baseUrl}${ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: request.signal,
      })

      // For poll, non-2xx responses may contain valid error data
      const data = await res.json()
      if (!res.ok && !data.error) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }
      return data as T
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      lastError = err
      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
      }
    } finally {
      request.cleanup()
    }
  }

  throw lastError
}

function emit(
  onStatus: ConnectOptions['onStatus'],
  status: RegistrationStatus,
) {
  onStatus?.(status)
}

/**
 * Create a new Feishu/Lark bot by scanning a QR code.
 *
 * The function initiates a device-code-style registration flow with Feishu's API.
 * A QR code URL is provided via the `onQRCode` callback. When the user scans it
 * with the Feishu mobile app, a new bot is created and its credentials are returned.
 */
export async function connectFeishuBot(
  options: ConnectOptions = {},
): Promise<ConnectResult> {
  const { onQRCode, onStatus, signal, env = 'prod' } = options
  let baseUrl = FEISHU_URLS[env] ?? FEISHU_URLS.prod

  // Step 1: Init
  emit(onStatus, { phase: 'initializing' })

  const initRes = await post<InitResponse>(baseUrl, { action: 'init' }, signal)

  if (!initRes.supported_auth_methods?.includes('client_secret')) {
    const msg =
      'Environment does not support client_secret auth method. Please try again later.'
    emit(onStatus, { phase: 'error', message: msg })
    throw new Error(msg)
  }

  // Step 2: Begin — request QR code
  const beginRes = await post<BeginResponse>(
    baseUrl,
    {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    },
    signal,
  )

  const qrUrl = new URL(beginRes.verification_uri_complete)
  qrUrl.searchParams.set('from', 'onboard')
  const qrUrlStr = qrUrl.toString()

  onQRCode?.(qrUrlStr)
  emit(onStatus, {
    phase: 'waiting_for_scan',
    qrUrl: qrUrlStr,
    expiresIn: beginRes.expire_in || 600,
  })

  // Step 3: Poll until scanned
  const startTime = Date.now()
  let interval = beginRes.interval || 5
  const expireIn = beginRes.expire_in || 600
  let domainSwitched = false

  while (Date.now() - startTime < expireIn * 1000) {
    signal?.throwIfAborted()

    await sleep(interval * 1000, signal)

    let pollRes: PollResponse
    try {
      pollRes = await post<PollResponse>(
        baseUrl,
        { action: 'poll', device_code: beginRes.device_code },
        signal,
      )
    } catch (err: unknown) {
      // Network errors during poll are transient — continue polling
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      continue
    }

    // Auto-detect Lark (international) and switch domain
    if (pollRes.user_info?.tenant_brand === 'lark' && !domainSwitched) {
      baseUrl = LARK_URLS[env] ?? LARK_URLS.prod
      domainSwitched = true
      continue
    }

    // Success
    if (pollRes.client_id && pollRes.client_secret) {
      const result: ConnectResult = {
        appId: pollRes.client_id,
        appSecret: pollRes.client_secret,
        userOpenId: pollRes.user_info?.open_id,
        domain: domainSwitched ? 'lark' : 'feishu',
      }
      emit(onStatus, { phase: 'success', ...result })
      return result
    }

    // Handle poll errors
    if (pollRes.error) {
      switch (pollRes.error) {
        case 'authorization_pending':
          break // Keep polling

        case 'slow_down':
          interval += 5
          break

        case 'access_denied':
          emit(onStatus, { phase: 'denied' })
          throw new Error('User denied authorization')

        case 'expired_token':
          emit(onStatus, { phase: 'expired' })
          throw new Error('QR code expired. Please try again.')

        default:
          emit(onStatus, {
            phase: 'error',
            message: pollRes.error_description || pollRes.error,
          })
          throw new Error(
            pollRes.error_description || `Registration failed: ${pollRes.error}`,
          )
      }
    }
  }

  // Timed out
  emit(onStatus, { phase: 'expired' })
  throw new Error('QR code expired. Please try again.')
}
