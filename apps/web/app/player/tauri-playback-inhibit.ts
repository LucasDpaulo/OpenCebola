import { invoke } from "@tauri-apps/api/core";
import { PlaybackWakeLock } from "./playback-wake-lock";

type InvokePlaybackInhibit = (command: "set_playback_inhibit", args: { active: boolean }) => Promise<unknown>;

/** Usa o inibidor do sistema operacional exposto pelo aplicativo Tauri. */
export function createTauriPlaybackWakeLock(invokeCommand: InvokePlaybackInhibit = invoke): PlaybackWakeLock {
  return new PlaybackWakeLock(async () => {
    await invokeCommand("set_playback_inhibit", { active: true });
    return {
      release: async () => {
        await invokeCommand("set_playback_inhibit", { active: false });
      }
    };
  });
}
