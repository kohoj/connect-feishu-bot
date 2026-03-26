const FEISHU_TOKEN_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'

/**
 * Validate a Feishu App ID and App Secret pair.
 *
 * Returns `true` if the credentials are valid, `false` otherwise.
 * Does not expose any token or secret — only a boolean result.
 */
export async function validateCredentials(
  appId: string,
  appSecret: string,
): Promise<boolean> {
  const cleanId = appId?.trim()
  const cleanSecret = appSecret?.trim()
  if (!cleanId || !cleanSecret) return false

  try {
    const res = await fetch(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cleanId, app_secret: cleanSecret }),
      signal: AbortSignal.timeout(10_000),
    })

    const data = (await res.json()) as {
      code?: number
      tenant_access_token?: string
    }
    return data.code === 0 && !!data.tenant_access_token
  } catch {
    return false
  }
}
