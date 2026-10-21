import { Type } from "@earendil-works/pi-ai";

export const imageGenerationDescription =
  "Generate raster images using the image model configured in Settings > Models. items supports distinct prompts and count variants; at most 10 images total. Each image may incur a charge. Generate only the requested number, report partial failures, and do not retry without the user's request. Results contain local image paths: display successful images with Markdown image links. For edits, provide images as local paths from the session, attachments, or project. Use previous result paths to refine generated images; preserve originals.";
export const imageGenerationParameters = {
  items: Type.Array(
    Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 32000 }),
      images: Type.Optional(
        Type.Union([
          Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 4 }),
          Type.Null(),
        ]),
      ),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    { minItems: 1, maxItems: 10 },
  ),
};

/**
 * mc-agent creative studio: register an image the agent drew with code (a
 * script it wrote and ran) as an asset of the current creative project, with
 * the script kept as its snapshot. Model-generated images register by
 * themselves; this is only for code drawings.
 */
export const saveCreativeAssetDescription =
  "Save an image you produced with code (a script you wrote and ran, e.g. Python/Pillow pixel art, charts, icons) into this creative project's asset library, so it appears in the Create workspace beside model-generated images. Pass the image path, the script path and the exact command you ran. Only for code drawings: images from GenerateImages are saved automatically. Call it for finished results, not for every intermediate attempt.";
export const saveCreativeAssetParameters = {
  imagePath: Type.String({ minLength: 1, maxLength: 4096, description: "The image file to save (project-relative, scratch, or absolute inside those)." }),
  scriptPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "The script that drew it." })),
  command: Type.Optional(Type.String({ maxLength: 4000, description: "The exact command that produced the image." })),
  category: Type.Optional(Type.String({ maxLength: 400, description: "Category folder to file it under, e.g. 角色/角色A; uncategorized when omitted." })),
};
