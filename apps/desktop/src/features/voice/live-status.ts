import { useSyncExternalStore } from "react";
import { getLiveCallController } from "./live/live-call-controller";

export function useLiveVoiceSnapshot() {
  const controller = getLiveCallController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function refreshLiveVoiceStatus() {
  return getLiveCallController().refreshStatus();
}
