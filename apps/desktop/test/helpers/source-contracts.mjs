import { readFileSync } from "node:fs";
export {
  readMainSource,
  readMainModule,
  readMainSourceSync,
  readMainModuleSync,
} from "./main-source.mjs";
export {
  readStoreSource,
  readStoreModule,
  readStoreSourceSync,
  readStoreModuleSync,
} from "./store-source.mjs";
export {
  readTranscriptSource,
  readTranscriptModule,
  readTranscriptSourceSync,
  readTranscriptModuleSync,
} from "./transcript-source.mjs";
export {
  readComposerSource,
  readComposerModule,
  readModelPickerModule,
  readComposerSourceSync,
  readComposerModuleSync,
} from "./composer-source.mjs";
export {
  readSharedTypesSource,
  readSharedTypesSourceSync,
} from "./shared-types-source.mjs";
export {
  readAppSource,
  readAppSourceSync,
  readPluginsSource,
  readPluginsSourceSync,
  readSettingsSource,
  readSettingsSourceSync,
} from "./domain-source.mjs";

export function readContractModules(...paths) {
  return paths.map((path) => readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8")).join("\n");
}
