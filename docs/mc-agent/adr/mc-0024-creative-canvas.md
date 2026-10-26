# MC-ADR-0024: 创作画布（二期 A 档）

**Status:** Accepted
**Date:** 2026-10-26
**Deciders:** 产品负责人

## 背景

方案见[创作画布方案](../creative-canvas.md)。创作工作台二期要一块画布：Agent 把几版方案并排摆出来，用户贴便签、对某个元素开评论、@Agent 让它改。参考 Claude 的 Design 画布对外公开的能力，不复用它的代码。用户确认先做完 A 档，D1–D5 按方案建议。

## 决定

1. **画板是 HTML 片段，画布只管摆放。** 画布是 `creative/canvas/<id>/` 下的真实文件：`canvas.json`（元素与版本号）、`comments.json`、`frames/<画板>.html` 和 `.prev.html`。不加数据库表；`canvas` 成为保留的分类名。
2. **一条写入路径。** 界面和 Agent 都调 host-core 的 `creative.canvas.*`：一批元素操作带读到时的版本号，版本不一致整批拒绝；先写画板文件再写索引，都用临时文件加改名。Agent 改画板时保留上一版，可以一步恢复（交换）。
3. **元素定位由 host-core 按源码给出。** host-core 用严格分词器读画板（标签闭合、属性带引号），写入时检查约定，服务时给每个开始标签注入 `data-mc-node`。画板里的脚本只能报编号和外框；地址 `<画板>#<编号>:<路径>`、`data-mc-id` 和标签文字都在源码里查。
4. **沙箱同 gen-ui。** 新协议 `mc-canvas://`（D1），只有 `standard` + `secure` 权限；画板在不带 `allow-same-origin` 的 iframe 里，CSP 禁止一切联网，图片只能来自本项目素材库（`asset:<id>` 在服务时改写，D2）；画框的权限请求一律拒绝。
5. **评论只让被交给的会话回答。** 线程记下交给的会话 ID（D5），`agent…` 方法按会话校验；这些方法和 `boardDocument` 不在渲染端白名单里。锚点按 `data-mc-id`、再按地址加标签文字找回，找不到就挂到画板上并标“原位置已变”，不挂到别的元素上。
6. **视图上下文与附件随消息固定。** 画布开着时，工作台对话的消息默认带上可见画板、选中元素和出错画板（D4）；评论、便签、错误作为附件。两者都用带随机标记的块包起来，注明是数据。会话运行中时排进下一轮。
7. **只在创作项目里。** 三个 Agent 工具 `CanvasRead` / `CanvasWrite` / `CanvasComment` 为低风险的 host-local 工具，会话不属于创作项目时拒绝（D3：普通项目在创作中打开即成为创作项目）。

## 影响

- 改动上游（各一两行接线）：`plugin-schemes.ts`、`bootstrap/startup.ts`、`index.html`、`live-voice/microphone-permissions.ts`、`runtime/sidecar.ts`、`packages/agent-runtime/src/runtime.ts`、`permissions.rs`、`tools/mod.rs`、`packages/shared/src/protocol.ts`、`src/lib/api.ts`。
- 新增：`mc_creative/canvas/*`、`rpc/mc_canvas_rpc.rs`、`packages/shared/src/mc-canvas.ts`、`electron/main/creative/canvas-*.ts`、`packages/agent-runtime/src/mc-canvas-tools.ts`、`src/features/creative/canvas/*`。

## 暂未做

- B 档（原型跳转、多页、参考线、导出）、C 档（所见即所得编辑）、手画工具。
- 删除画板不能在界面撤销（HTML 文件随之删除）；Agent 改动只保留上一版。

## 重访条件

- 做 C 档时，自由 HTML 改不动就换成更严格的组件格式，另起 ADR。
