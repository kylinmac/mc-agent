import { describe, expect, it } from "vitest";
import { canvasAssetUrlPrefix, canvasBoardUrl, canvasLocationFromUrl, fenceCanvasData, stripCanvasData } from "./mc-canvas";

describe("mc-canvas URLs", () => {
  it("round-trips board and asset locations", () => {
    expect(canvasLocationFromUrl(canvasBoardUrl("g-1", "c1", "login-a", 7))).toEqual({
      kind: "board",
      groupId: "g-1",
      canvasId: "c1",
      boardId: "login-a",
    });
    expect(canvasLocationFromUrl(`${canvasAssetUrlPrefix("g-1")}3f2a-11`)).toEqual({
      kind: "asset",
      groupId: "g-1",
      assetId: "3f2a-11",
    });
  });

  it("refuses anything else", () => {
    for (const url of [
      "pi-genui://session/x/y.html",
      "mc-canvas://board/g/c/../1",
      "mc-canvas://board/g/c/b",
      "mc-canvas://board/g/c/b/1/extra",
      "mc-canvas://board/g/c/b/x",
      "mc-canvas://other/g/c",
      "mc-canvas://asset/g/a b",
      "mc-canvas://user:pw@board/g/c/b/1",
      "mc-canvas://board/g/c/b/1#x",
      "not a url",
    ]) {
      expect(canvasLocationFromUrl(url), url).toBeNull();
    }
  });

  it("fences canvas data and strips only matching fences", () => {
    const block = fenceCanvasData("view", '{"a":1}', "abc123def456");
    const { text, blocks } = stripCanvasData(`${block}\n\nhello <mc-canvas-view-zzz>not closed`);
    expect(blocks).toBe(1);
    expect(text).toBe("hello <mc-canvas-view-zzz>not closed");
  });
});
