/**
 * GitHub Copilot Authentication
 *
 * Manages the two-stage auth flow for the Copilot Chat API:
 * 1. GitHub Token (PAT or OAuth) — long-lived user credential
 * 2. Copilot Session Token — short-lived token (~30min) obtained via GitHub API
 *
 * Also provides GitHub Device Flow OAuth for interactive user authentication.
 *
 * Works in both main thread and worker threads (no Electron APIs needed).
 */

// =============================================================================
// Debug Logging
// =============================================================================

const DEBUG = process.env.DEBUG === 'true' || process.argv.includes('--debug');

function debugLog(message: string, data?: unknown): void {
  if (!DEBUG) return;
  const prefix = `[CopilotAuth ${new Date().toISOString()}]`;
  if (data !== undefined) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }
}

// =============================================================================
// Constants
// =============================================================================

/** GitHub API endpoint for exchanging a GitHub token for a Copilot session token */
const COPILOT_TOKEN_ENDPOINT = 'https://api.github.com/copilot_internal/v2/token';

/** GitHub Device Flow endpoints */
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * GitHub OAuth App Client ID for Aperant.
 * This is a public identifier (not a secret) used for the Device Flow.
 * Must be registered at https://github.com/settings/developers
 */
const GITHUB_OAUTH_CLIENT_ID = 'Iv1.aperant_copilot';

/** Scopes required for Copilot access */
const GITHUB_COPILOT_SCOPE = 'copilot';

/** Refresh session token 5 minutes before expiry */
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/** Default poll interval for Device Flow (seconds) */
const DEFAULT_DEVICE_FLOW_INTERVAL = 5;

// =============================================================================
// Copilot Session Token Types
// =============================================================================

interface CopilotSessionToken {
  /** The session token (tid=...) */
  token: string;
  /** Unix timestamp (seconds) when this token expires */
  expires_at: number;
}

// =============================================================================
// Copilot Token Manager
// =============================================================================

/**
 * Manages Copilot session tokens with automatic refresh.
 * Session tokens are short-lived (~30 min) and obtained by exchanging
 * a GitHub token via the Copilot internal API.
 */
export class CopilotTokenManager {
  private cachedToken: CopilotSessionToken | null = null;
  private refreshPromise: Promise<CopilotSessionToken> | null = null;

  constructor(private githubToken: string) {}

  /**
   * Get a valid Copilot session token, refreshing if necessary.
   * Coalesces concurrent refresh requests to avoid duplicate API calls.
   */
  async getToken(): Promise<string> {
    if (this.cachedToken && !this.isNearExpiry(this.cachedToken)) {
      return this.cachedToken.token;
    }

    // Coalesce concurrent refresh requests
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken();
    }

    try {
      const token = await this.refreshPromise;
      this.cachedToken = token;
      return token.token;
    } finally {
      this.refreshPromise = null;
    }
  }

  /** Update the GitHub token (e.g., after re-authentication) */
  updateGitHubToken(newToken: string): void {
    this.githubToken = newToken;
    this.cachedToken = null;
    this.refreshPromise = null;
  }

  private isNearExpiry(token: CopilotSessionToken): boolean {
    const expiresAtMs = token.expires_at * 1000;
    return Date.now() >= expiresAtMs - TOKEN_REFRESH_THRESHOLD_MS;
  }

  private async refreshToken(): Promise<CopilotSessionToken> {
    debugLog('Refreshing Copilot session token');
    return exchangeForCopilotToken(this.githubToken);
  }
}

// =============================================================================
// Token Exchange
// =============================================================================

/**
 * Exchange a GitHub token (PAT or OAuth access token) for a Copilot session token.
 *
 * @param githubToken - GitHub Personal Access Token or OAuth access token
 * @returns Copilot session token with expiration
 * @throws If the exchange fails (invalid token, no Copilot subscription, etc.)
 */
export async function exchangeForCopilotToken(githubToken: string): Promise<CopilotSessionToken> {
  debugLog('Exchanging GitHub token for Copilot session token');

  const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
    method: 'GET',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Accept': 'application/json',
      'User-Agent': 'Aperant-Desktop/1.0',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    debugLog('Copilot token exchange failed', { status: response.status, body });

    if (response.status === 401) {
      throw new Error('Invalid GitHub token. Please re-authenticate.');
    }
    if (response.status === 403) {
      throw new Error(
        'GitHub Copilot access denied. Ensure you have an active Copilot subscription ' +
        'and your token has the required scopes.'
      );
    }
    throw new Error(`Copilot token exchange failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as CopilotSessionToken;
  debugLog('Copilot session token obtained', { expires_at: data.expires_at });
  return data;
}

// =============================================================================
// Custom Fetch Interceptor
// =============================================================================

/**
 * Creates a custom fetch interceptor for Copilot API requests.
 * Automatically manages session token lifecycle:
 * 1. Obtains/renews Copilot session token from GitHub token
 * 2. Injects Authorization header with session token
 *
 * @param githubToken - GitHub Personal Access Token or OAuth access token
 * @returns Custom fetch function compatible with @ai-sdk/openai
 */
export function createCopilotFetch(githubToken: string): typeof globalThis.fetch {
  const tokenManager = new CopilotTokenManager(githubToken);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sessionToken = await tokenManager.getToken();

    // Build headers from scratch, copying everything except Authorization
    // (which the SDK sets to the raw GitHub PAT — we need the Copilot session token instead)
    const originalHeaders = new Headers(init?.headers);
    const headers = new Headers();

    // Copy all non-auth headers from the SDK's request
    originalHeaders.forEach((value, key) => {
      if (key.toLowerCase() !== 'authorization') {
        headers.set(key, value);
      }
    });

    // Set the correct Copilot session token
    headers.set('Authorization', `Bearer ${sessionToken}`);

    const url = typeof input === 'string' ? input : input.toString();
    debugLog('Copilot fetch', { url, tokenLength: sessionToken.length });

    return globalThis.fetch(input, {
      ...init,
      headers,
    });
  };
}

// =============================================================================
// GitHub Device Flow OAuth
// =============================================================================

/** Result of initiating the Device Flow */
export interface DeviceFlowInitResult {
  /** Code the user must enter at the verification URI */
  userCode: string;
  /** URI where the user enters the code */
  verificationUri: string;
  /** Internal device code for polling */
  deviceCode: string;
  /** Poll interval in seconds */
  interval: number;
  /** Device code expiry in seconds */
  expiresIn: number;
}

/** Result of completing the Device Flow */
export interface DeviceFlowResult {
  /** GitHub OAuth access token */
  accessToken: string;
  /** Token type (always 'bearer') */
  tokenType: string;
  /** Granted scopes */
  scope: string;
}

/**
 * Start the GitHub Device Flow OAuth process.
 * Returns a device code and user code. The user must visit the verification URI
 * and enter the user code to authorize the application.
 *
 * @param clientId - Optional custom OAuth App client ID (for GitHub Enterprise)
 * @returns Device flow initiation result with user_code and verification_uri
 */
export async function startGitHubDeviceFlow(
  clientId?: string,
): Promise<DeviceFlowInitResult> {
  debugLog('Starting GitHub Device Flow');

  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId ?? GITHUB_OAUTH_CLIENT_ID,
      scope: GITHUB_COPILOT_SCOPE,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub Device Flow initiation failed: ${response.status} ${body}`);
  }

  const data = await response.json();

  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    interval: data.interval ?? DEFAULT_DEVICE_FLOW_INTERVAL,
    expiresIn: data.expires_in,
  };
}

/**
 * Poll GitHub for the access token after the user has entered the device code.
 * This should be called repeatedly at the specified interval until success or expiry.
 *
 * @param deviceCode - Device code from startGitHubDeviceFlow()
 * @param clientId - Optional custom OAuth App client ID
 * @returns The access token result, or null if still pending
 * @throws On permanent errors (expired, access_denied, etc.)
 */
export async function pollGitHubDeviceFlow(
  deviceCode: string,
  clientId?: string,
): Promise<DeviceFlowResult | null> {
  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId ?? GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub Device Flow poll failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    switch (data.error) {
      case 'authorization_pending':
        // User hasn't entered the code yet — keep polling
        return null;
      case 'slow_down':
        // Polling too fast — caller should increase interval
        debugLog('Device Flow: slow_down, increase poll interval');
        return null;
      case 'expired_token':
        throw new Error('Device code expired. Please start the authentication again.');
      case 'access_denied':
        throw new Error('User denied access. Please try again and authorize the application.');
      default:
        throw new Error(`GitHub Device Flow error: ${data.error} - ${data.error_description ?? ''}`);
    }
  }

  if (data.access_token) {
    debugLog('Device Flow: access token obtained');
    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      scope: data.scope,
    };
  }

  return null;
}

/**
 * Complete the full Device Flow in a single async call.
 * Polls GitHub at the specified interval until the user authorizes or the code expires.
 *
 * @param deviceCode - Device code from startGitHubDeviceFlow()
 * @param interval - Poll interval in seconds
 * @param expiresIn - Maximum time to wait in seconds
 * @param onPoll - Optional callback for each poll attempt (for UI progress)
 * @param signal - Optional AbortSignal to cancel polling
 * @param clientId - Optional custom OAuth App client ID
 * @returns The access token result
 * @throws On timeout, denial, or abort
 */
export async function completeGitHubDeviceFlow(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  onPoll?: () => void,
  signal?: AbortSignal,
  clientId?: string,
): Promise<DeviceFlowResult> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Device Flow authentication was cancelled.');
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
    onPoll?.();

    try {
      const result = await pollGitHubDeviceFlow(deviceCode, clientId);
      if (result) return result;
    } catch (error) {
      // Re-throw permanent errors
      if (error instanceof Error && !error.message.includes('slow_down')) {
        throw error;
      }
      // On slow_down, increase interval by 5 seconds
      pollInterval += 5;
    }
  }

  throw new Error('Device code expired. Please start the authentication again.');
}
