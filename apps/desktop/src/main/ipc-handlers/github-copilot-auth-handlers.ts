/**
 * GitHub Copilot Auth Handlers
 *
 * Authenticates via the GitHub Device Flow using the public VS Code Copilot
 * OAuth client ID. Only tokens issued to a Copilot-whitelisted OAuth app are
 * accepted by GitHub's /copilot_internal/v2/token endpoint, so neither PATs nor
 * gh CLI tokens work here — the Device Flow is the only viable path.
 *
 * UX: opens GitHub's device-code verification page in the user's browser and
 * copies the user code to the clipboard, then polls GitHub until the user
 * approves the authorization.
 */

import { ipcMain, shell, clipboard } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  startGitHubDeviceFlow,
  completeGitHubDeviceFlow,
} from '../ai/providers/copilot-auth';

/**
 * Fetch the authenticated user's login and email from the GitHub API.
 * Uses the OAuth access token obtained from the Device Flow.
 */
async function fetchGitHubUser(
  accessToken: string,
): Promise<{ login: string; email?: string } | null> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'GithubCopilot/1.155.0',
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { login: string; email?: string };
    return { login: data.login, email: data.email ?? undefined };
  } catch {
    return null;
  }
}

export function registerGitHubCopilotAuthHandlers(): void {
  /**
   * Start the full GitHub Device Flow: fetch a device code, open the
   * verification URI in the browser (with the user code copied to the
   * clipboard), poll GitHub until the user approves, then return the
   * resulting access token and user profile.
   *
   * The renderer treats this as one blocking call — the COMPLETE handler
   * below is kept as a no-op for API compatibility.
   */
  ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_AUTH_START_DEVICE_FLOW, async () => {
    try {
      const deviceFlow = await startGitHubDeviceFlow();

      // Help the user: put the code on the clipboard and open the verification page.
      try {
        clipboard.writeText(deviceFlow.userCode);
      } catch { /* clipboard may not be available in all contexts */ }
      try {
        await shell.openExternal(deviceFlow.verificationUri);
      } catch { /* user will open it manually if this fails */ }

      console.log(
        `[CopilotAuth] Device Flow started. Enter code ${deviceFlow.userCode} at ${deviceFlow.verificationUri} (code copied to clipboard).`,
      );

      const tokenResult = await completeGitHubDeviceFlow(
        deviceFlow.deviceCode,
        deviceFlow.interval,
        deviceFlow.expiresIn,
      );

      const user = await fetchGitHubUser(tokenResult.accessToken);

      return {
        success: true,
        data: {
          accessToken: tokenResult.accessToken,
          email: user?.email ?? `${user?.login ?? 'user'}@github.com`,
          username: user?.login,
          userCode: deviceFlow.userCode,
          verificationUri: deviceFlow.verificationUri,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during GitHub Device Flow',
      };
    }
  });

  /**
   * Kept for API compatibility with the previous gh-CLI-based flow.
   * The START handler already runs the complete flow synchronously.
   */
  ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_AUTH_COMPLETE_DEVICE_FLOW, async () => {
    return { success: true, data: {} };
  });
}
