# MC-ADR-0024: 原型画布（A 档）

**Status:** Accepted
**Date:** 2026-10-26（2026-10-27 修订：从创作工作台移出，成为会话工作面板里的标签）
**Deciders:** 产品负责人

## 背景

方案见[原型画布方案](../prototype-canvas.md)。画布主要给 Agent 用：它把产品原型画成可交互的 HTML 画板，人看、试交互、评论，再让 Agent 改。参考 Claude 的 Design 画布对外公开的能力，不复用它的代码。

最初按“创作工作台二期”做进了创作工作台。2026-10-27 用户指出画布是画产品原型的，和生图无关，改为独立功能：放在会话工作面板里，挂普通项目，存数据目录，人这边以看、交互、评论为主。

## 决定

1. **画板是 HTML 片段，画布只管摆放。** 画布是 `<数据目录>/canvas/<项目>/<id>/` 下的普通文件：`canvas.json`（元素与版本号）、`comments.json`、`frames/<画板>.html` 和 `.prev.html`。不进代码仓库，不加数据库表。只建了文件夹的项目（ID 为 `legacy:<路径>`）用 ID 摘要作目录名。
2. **一条写入路径。** 界面和 Agent 都调 host-core 的 `canvas.*`：一批元素操作带读到时的版本号，版本不一致整批拒绝；先写画板文件再写索引，都用临时文件加改名。Agent 改画板时保留上一版，可以一步恢复（交换）。
3. **元素定位由 host-core 按源码给出。** host-core 用严格分词器读画板（标签闭合、属性带引号），写入时检查约定，服务时给每个开始标签注入 `data-mc-node`。画板里的脚本只能报编号和外框；地址 `<画板>#<编号>:<路径>`、`data-mc-id` 和标签文字都在源码里查。
4. **沙箱同 gen-ui。** 新协议 `mc-canvas://`（D1），只有 `standard` + `secure` 权限；画板在不带 `allow-same-origin` 的 iframe 里，CSP 禁止一切联网，图片只允许 `data:` / `blob:`（D2）；画框的权限请求一律拒绝。
5. **画布是会话工作面板里的标签（D3）。** 每个会话一个“画布”标签，显示本项目的某张画布；Agent 写画布时自动打开它所在会话的标签。人这边只有选择、抓手、评论三个工具，可以拖动排布、进入画板交互、选元素；便签和大标题由 Agent 写。
6. **评论只让被交给的会话回答（D5）。** @Agent 交给画布旁边的这个会话，线程记下它的 ID；`agent…` 方法按会话校验，这些方法和 `boardDocument` 不在渲染端白名单里。锚点按 `data-mc-id`、再按地址加标签文字找回，找不到就挂到画板上并标“原位置已变”，不挂到别的元素上。
7. **视图上下文与附件随消息固定（D4）。** 画布标签开着时，这个会话的消息默认带上可见画板、选中元素和出错画板；评论、便签、错误作为附件。两者都用带随机标记的块包起来，注明是数据；对话里显示消息时去掉。会话运行中时排进下一轮。
8. **本地项目的会话都有工具。** `CanvasRead` / `CanvasWrite` / `CanvasComment` 为低风险的 host-local 工具；会话不在项目里时拒绝。工具说明只写要点，详细指南随对话里第一个画布工具结果返回（`CanvasRead` 传 `guide: true` 可再取）。

## 影响

- 改动上游（各一两行接线）：`plugin-schemes.ts`、`bootstrap/startup.ts`、`index.html`、`live-voice/microphone-permissions.ts`、`ipc/register.ts`、`runtime/sidecar.ts`、`packages/agent-runtime/src/runtime.ts`、`permissions.rs`、`tools/mod.rs`、`rpc/mod.rs`、`main.rs`、`packages/shared/src/protocol.ts`、`src/lib/api.ts`、`lib/work-panel-tabs.ts`、`components/workpanel/WorkPanel.tsx`、`components/Composer.tsx`、`transcript/MessageRow.tsx`。
- 新增：`crates/host-core/src/mc_canvas/*`、`rpc/mc_canvas_rpc.rs`、`packages/shared/src/mc-canvas.ts`、`electron/main/canvas/*`、`electron/main/ipc/mc-canvas-ipc.ts`、`packages/agent-runtime/src/mc-canvas-tools.ts`、`src/features/canvas/*`。
- 创作工作台不变。

## 暂未做

- B 档（原型跳转、多页、参考线、导出）、C 档（所见即所得编辑）、手画工具。
- 删除画板不能在界面撤销（HTML 文件随之删除）；Agent 改动只保留上一版。
- 删除项目时不清理它的画布目录。

## 重访条件

- 做 C 档时，自由 HTML 改不动就换成更严格的组件格式，另起 ADR。
