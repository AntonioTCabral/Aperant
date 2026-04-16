/**
 * GitHub Copilot Auth Handlers
 *
 * Uses the gh CLI (GitHub CLI) for authentication:
 * - If gh is already authenticated: reads the token with `gh auth token`
 * - If not: runs `gh auth login --web` to trigger browser-based OAuth
 * - Gets user info via `gh api user`
 *
 * This avoids the need for a registered OAuth App — it piggybacks on the
 * gh CLI's own OAuth App which the user already has installed.
 */

import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { IPC_CHANNELS } from '../../shared/constants';
import { getToolPath } from '../cli-tool-manager';
import { getAugmentedEnv } from '../env-utils';

const execFileAsync = promisify(execFile);

/**
 * Try to get the current gh CLI auth token.
 * Returns null if gh is not installed or not authenticated.
 */
async function getGhToken(): Promise<string | null> {
  try {
    const ghPath = getToolPath('gh');
    const { stdout } = await execFileAsync(ghPath, ['auth', 'token'], {
      encoding: 'utf-8',
      env: getAugmentedEnv(),
    });
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get the authenticated GitHub user's login and email.
 */
async function getGhUser(): Promise<{ login: string; email?: string } | null> {
  try {
    const ghPath = getToolPath('gh');
    const { stdout } = await execFileAsync(ghPath, ['api', 'user', '--jq', '.login + "\\n" + (.email // "")'], {
      encoding: 'utf-8',
      env: getAugmentedEnv(),
    });
    const lines = stdout.trim().split('\n');
    return {
      login: lines[0] || 'unknown',
      email: lines[1] || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Run `gh auth login` with web-based OAuth flow.
 * This opens the user's browser for GitHub authentication.
 */
async function runGhAuthLogin(): Promise<{ success: boolean; error?: string }> {
  try {
    const ghPath = getToolPath('gh');
    await execFileAsync(ghPath, ['auth', 'login', '--web', '-h', 'github.com', '-s', 'copilot'], {
      encoding: 'utf-8',
      env: getAugmentedEnv(),
      timeout: 120_000, // 2 min timeout for user to complete browser auth
    });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'gh auth login failed',
    };
  }
}

export function registerGitHubCopilotAuthHandlers(): void {
  /**
   * Start Copilot OAuth: check if gh is authenticated, if not trigger login.
   * Returns the GitHub token and user info on success.
   */
  ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_AUTH_START_DEVICE_FLOW, async () => {
    try {
      // Step 1: Check if gh CLI is available
      let ghPath: string;
      try {
        ghPath = getToolPath('gh');
      } catch {
        return {
          success: false,
          error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com then try again.',
        };
      }

      // Step 2: Check if already authenticated
      let token = await getGhToken();

      if (!token) {
        // Step 3: Not authenticated — run gh auth login
        const loginResult = await runGhAuthLogin();
        if (!loginResult.success) {
          return {
            success: false,
            error: loginResult.error ?? 'GitHub authentication failed. Please try again.',
          };
        }

        // Step 4: Get the token after login
        token = await getGhToken();
        if (!token) {
          return {
            success: false,
            error: 'Authentication completed but could not retrieve token. Please try again.',
          };
        }
      }

      // Step 5: Get user info
      const user = await getGhUser();

      return {
        success: true,
        data: {
          accessToken: token,
          email: user?.email || `${user?.login ?? 'user'}@github.com`,
          username: user?.login,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during GitHub authentication',
      };
    }
  });

  /**
   * Complete flow — kept for API compatibility but the start handler does everything.
   * With gh CLI auth, there's no polling needed.
   */
  ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_AUTH_COMPLETE_DEVICE_FLOW, async () => {
    return { success: true, data: {} };
  });
}
