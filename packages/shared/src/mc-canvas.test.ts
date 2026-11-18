import { describe, expect, it } from "vitest";
import { canvasBoardUrl, canvasLocationFromUrl, fenceCanvasData, stripCanvasData } from "./mc-canvas";
import {
  applyWhiteboardOpsToScene,
  parseSessionCanvasGroupId,
  sessionCanvasGroupId,
  summarizeWhiteboardScene,
} from "./mc-whiteboard";

describe("mc-canvas URLs", () => {
  it("round-trips board locations, a folder-only project's id included", () => {
    expect(canvasLocationFromUrl(canvasBoardUrl("g-1", "c1", "login-a", 7))).toEqual({
      kind: "board",
      groupId: "g-1",
      canvasId: "c1",
      boardId: "login-a",
    });
    expect(canvasLocationFromUrl(canvasBoardUrl("legacy:/Users/me/web app", "c1", "a", 1))?.groupId).toBe(
      "legacy:/Users/me/web app",
    );
  });

  it("refuses anything else", () => {
    for (const url of [
      "pi-genui://session/x/y.html",
      "mc-canvas://board/g/c/../1",
      "mc-canvas://board/g/c/b",
      "mc-canvas://board/g/c/b/1/extra",
      "mc-canvas://board/g/c/b/x",
      "mc-canvas://other/g/c",
      "mc-canvas://asset/g/a1",
      "mc-canvas://board/g/c/b/1?x=1",
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

  it("encodes session canvas group IDs and builds/summarizes Excalidraw whiteboard scenes", () => {
    expect(parseSessionCanvasGroupId(sessionCanvasGroupId("sess-123"))).toBe("sess-123");
    expect(parseSessionCanvasGroupId("g-1")).toBeNull();
    expect(parseSessionCanvasGroupId("session:../bad")).toBeNull();

    const { scene, added } = applyWhiteboardOpsToScene(null, [
      {
        op: "add",
        element: { id: "boxA", type: "rectangle", x: 100, y: 100, w: 180, h: 80, label: "登录输入", backgroundColor: "#e7f5ff" },
      },
      {
        op: "add",
        element: { id: "checkB", type: "diamond", x: 380, y: 100, w: 160, h: 80, label: "校验通过?" },
      },
      {
        op: "add",
        element: { id: "edge1", type: "arrow", startId: "boxA", endId: "checkB", label: "提交" },
      },
    ]);
    expect(added).toEqual(["boxA", "checkB", "edge1"]);
    const summary = summarizeWhiteboardScene(scene);
    expect(summary.totalElements).toBe(3);
    expect(summary.elements).toEqual([
      expect.objectContaining({ id: "boxA", type: "rectangle", text: "登录输入", backgroundColor: "#e7f5ff" }),
      expect.objectContaining({ id: "checkB", type: "diamond", text: "校验通过?" }),
      expect.objectContaining({ id: "edge1", type: "arrow", startId: "boxA", endId: "checkB", text: "提交" }),
    ]);

    const updated = applyWhiteboardOpsToScene(scene, [
      { op: "update", id: "boxA", set: { x: 140, y: 120, label: "手机号输入" } },
      { op: "add", id: "flatBox", type: "ellipse", x: 600, y: 100, w: 140, h: 70, label: "结果页" },
      { op: "update", id: "flatBox", label: "成功页" },
      // Moving `checkB` without `label` recomputes `edge1` arrow endpoints and re-centers `checkB`'s label:
      { op: "update", id: "checkB", set: { x: 460, y: 180 } },
    ]);
    const summary2 = summarizeWhiteboardScene(updated.scene, { maxElements: 2 });
    expect(summary2.totalElements).toBe(4);
    expect(summary2.elements.length).toBe(2);
    const fullSummary2 = summarizeWhiteboardScene(updated.scene);
    expect(fullSummary2.elements.find((e) => e.id === "boxA")?.text).toBe("手机号输入");
    expect(fullSummary2.elements.find((e) => e.id === "flatBox")?.text).toBe("成功页");

    // Removing `checkB` clears `edge1`'s endBinding cleanly:
    const afterRemove = applyWhiteboardOpsToScene(updated.scene, [{ op: "remove", id: "checkB" }]);
    const edgeAfter = summarizeWhiteboardScene(afterRemove.scene).elements.find((e) => e.id === "edge1");
    expect(edgeAfter?.endId).toBeUndefined();
  });
});
