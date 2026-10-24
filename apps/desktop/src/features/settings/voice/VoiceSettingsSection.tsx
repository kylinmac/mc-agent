import type { ComponentProps } from "react";
import { LiveVoiceSettings } from "./LiveVoiceSettings";
import { DictationSettings } from "./DictationSettings";

export function VoiceSettingsSection(props: ComponentProps<typeof LiveVoiceSettings>) {
  return <><DictationSettings {...props} /><LiveVoiceSettings {...props} /></>;
}
