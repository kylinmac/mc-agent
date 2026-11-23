# MC-ADR-0030: 画布并存 Excalidraw 白板与双向草图沟通（R38）

**Status:** Accepted
**Date:** 2026-11-18
**Deciders:** 产品负责人

## 背景

[MC-ADR-0024](mc-0024-prototype-canvas.md)（R18）实现了以 HTML 沙箱画板为核心的原型画布，适合 Agent 输出可交互界面原型并由用户点选元素、打评论针。但在日常沟通中，用户经常需要像画图／白板软件那样**亲手画框、拉连线箭头、圈重点、写文字说明、直接粘贴参考截图**来向 Agent 表达布局意图或流程逻辑，也希望 Agent 能直接往白板里画流程图、架构图与线框图，且在不属于任何项目的临时对话中同样可用。

## 决定

1. **单「画布」标签下并存两类画布（`prototype` 与 `whiteboard`）。** 工作面板仍保留单一「画布」入口，`Canvas` 记录新增 `kind: "prototype" | "whiteboard"`（缺省为 `"prototype"`，旧数据零迁移兼容）。新建时可选「白板草图（Excalidraw）」或「HTML 原型」；两者各自保持原生手势与坐标系，互不抢鼠标与缩放。HTML 原型画板提供「送入白板批注」动作，可将画板画面截为底图送入白板圈画对比。
2. **本地离线按需加载 `@excalidraw/excalidraw`（MIT）。** 白板视图通过 `React.lazy` 独立拆包，不影响应用冷启动体积；字体与静态资源随本地构建产物离线提供（设置本地 `EXCALIDRAW_ASSET_PATH`），不访问外网 CDN，保持现有渲染端 CSP 不变。
3. **所有本地对话可用，按归属隔离存储。** 项目内对话沿用 `<数据目录>/canvas/<项目ID>/<画布ID>/` 同项目共享；不属于项目的本地临时对话使用 `session:<会话ID>` 作用域，存放在 `<数据目录>/canvas/p-<摘要>/<画布ID>/`（`p-<sha256("session:<id>")[..32]>`），并在 `delete_session` 时随会话一并清理。白板数据拆分为 `canvas.json`（元信息与版本号）、`whiteboard.json`（场景元素与视图背景）、`files/<fileId>.json`（贴图二进制资源，避免大体积 Base64 混入结构 JSON）和 `preview.png`（防抖生成的最新画面快照）。
4. **省 Token 的按需读取 + 主动局部／全局发送双通道。**
   - **主动发送**：白板顶栏提供「附带到对话」与「发给 Agent」；存在选中元素时仅导出选中区域 PNG 与对应元素摘要，未选中时导出全部有内容区域 PNG 与摘要。「附带到对话」挂在输入框上方的 `CanvasContextBar` 芯片中，发送消息时自动合入图片附件且不覆盖输入框已有文字和附件。
   - **按需读取**：平时聊天不自动附带大图，仅在视图上下文携带轻量白板元信息（画布 ID、标题、版本、元素数与选中 ID）；用户直接说“看下画布”时，Agent 调用 `CanvasRead` 即可同时获得白板结构摘要（形状、文字、箭头连线绑定关系）与 `preview.png` 多模态图像块（视觉模型可直接看见贴图与手绘笔迹）。
5. **双向共创（Agent 写入白板）。** `CanvasWrite` 支持 `kind: "whiteboard"` 与结构化 `whiteboardOps`（增／改／删／清空矩形、圆、菱形、文字、直线、自动计算绑定的 `startId -> endId` 箭头及分组框），在主进程／共享层展开为合法 Excalidraw 元素并经 `canvas.whiteboard.agentSave`（仅 Main 可调，不在渲染端白名单中）带版本号落盘，触发前端实时刷新。

## 影响

- 新增：`docs/mc-agent/adr/mc-0030-whiteboard-canvas.md`、`packages/shared/src/mc-whiteboard.ts`、`crates/host-core/src/mc_canvas/whiteboard.rs`、`apps/desktop/src/features/canvas/WhiteboardView.tsx`、`apps/desktop/src/features/canvas/use-toolbar-focusgroup.ts`。
- 扩展：`packages/shared/src/mc-canvas.ts`、`crates/host-core/src/mc_canvas/mod.rs`、`crates/host-core/src/rpc/mc_canvas_rpc.rs`、`crates/host-core/src/sessions.rs`（临时会话画布删除清理）、`packages/agent-runtime/src/mc-canvas-tools.ts`、`packages/agent-runtime/src/runtime.ts`、`apps/desktop/electron/main/canvas/canvas-tools.ts`、`apps/desktop/electron/main/ipc/mc-canvas-ipc.ts`、`apps/desktop/src/features/canvas/*`、`apps/desktop/src/features/chat/Composer.tsx`（合入白板快照图片引用）。
- 现有 `prototype` 类型画布的协议（`mc-canvas://board/...`）、HTML 沙箱校验、元素拾取与评论线程行为保持不变。
