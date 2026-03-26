export interface ConnectOptions {
  /** Called when the QR code URL is ready. Display it to the user. */
  onQRCode?: (url: string) => void

  /** Called on status changes during the registration flow. */
  onStatus?: (status: RegistrationStatus) => void

  /** AbortSignal to cancel the registration flow. */
  signal?: AbortSignal

  /** API environment. Default: 'prod' */
  env?: 'prod' | 'boe' | 'pre'
}

export type RegistrationStatus =
  | { phase: 'initializing' }
  | { phase: 'waiting_for_scan'; qrUrl: string; expiresIn: number }
  | {
      phase: 'success'
      appId: string
      appSecret: string
      userOpenId?: string
      domain: 'feishu' | 'lark'
    }
  | { phase: 'denied' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string }

export interface ConnectResult {
  /** The App ID of the newly created bot (e.g. "cli_a93xxxxxxxxxxxx") */
  appId: string

  /** The App Secret of the newly created bot */
  appSecret: string

  /** The open_id of the user who scanned the QR code */
  userOpenId?: string

  /** Whether this is a Feishu (China) or Lark (International) bot */
  domain: 'feishu' | 'lark'
}

// -- Internal API response types --

export interface InitResponse {
  supported_auth_methods: string[]
}

export interface BeginResponse {
  device_code: string
  verification_uri_complete: string
  interval: number
  expire_in: number
}

export interface PollResponse {
  client_id?: string
  client_secret?: string
  user_info?: {
    open_id?: string
    tenant_brand?: string
  }
  error?: string
  error_description?: string
}
