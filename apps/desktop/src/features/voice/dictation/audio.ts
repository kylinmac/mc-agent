import { DICTATION_MAX_SECONDS } from "@pi-desktop/shared";

export function encodeDictationWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  if (!samples.length || samples.length > 16000 * DICTATION_MAX_SECONDS) throw new Error("DICTATION_INVALID_AUDIO");
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + index * 2, value < 0 ? value * 32768 : value * 32767, true); });
  return bytes;
}

export async function recordingToWav(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (!blob.size || blob.size > 12 * 1024 * 1024) throw new Error("DICTATION_INVALID_AUDIO");
  const decoder = new OfflineAudioContext(1, 1, 16000);
  const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  if (audio.duration > DICTATION_MAX_SECONDS + 1) throw new Error("DICTATION_INVALID_AUDIO");
  const length = Math.min(16000 * DICTATION_MAX_SECONDS, Math.ceil(audio.duration * 16000));
  const context = new OfflineAudioContext(1, Math.max(1, length), 16000);
  const source = context.createBufferSource();
  source.buffer = audio; source.connect(context.destination); source.start();
  return encodeDictationWav((await context.startRendering()).getChannelData(0));
}
