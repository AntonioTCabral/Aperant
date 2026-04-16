import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { startGitHubDeviceFlow, completeGitHubDeviceFlow } from '../ai/providers/copilot-auth';

export function registerGitHubCopilotAuthHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_AUTH_START_DEVICE_FLOW, async () => {
    try {
      const result = await startGitHubDeviceFlow();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_COPILOT_AUTH_COMPLETE_DEVICE_FLOW, async (_event, deviceCode: string, interval: number, expiresIn: number) => {
    try {
      const result = await completeGitHubDeviceFlow(deviceCode, interval, expiresIn);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
}
