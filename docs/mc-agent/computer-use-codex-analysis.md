# Codex Computer Use 的效率做法（行为分析）

**目的：** 给 [电脑操作方案](computer-use.md) 的二期改造做依据。只记录行为和格式，不复制对方代码。
**来源：** 本机 `ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/{sky,cua,cua-repl}` 自带的文档（`sky/docs/*.md`、`sky/docs/skills/oai_sky_lib/macos/SKILL.md`、`cua-repl/instructions/*`），以及一份 Codex 会话记录（2026-10-13，操作 Clash Verge）。原有分析见上一层 `分析成果/codex-desktop/computer-use/`（缺少这层 JS 与真实记录）。

## 结论：快在“少往返、少返回、不停下”

单步并不快：真实记录里每次“动作 + 等待 + 读状态”耗时 2.5–5.5 秒，读一次完整树约 2.9 秒。快在以下几点。

| 做法 | Codex | 我们一期 |
|---|---|---|
| 一次调用做几步 | 模型写一段 JS，连做多个动作再读一次状态（`click(38); getAXState()`） | 一个工具一步 |
| 动作的返回 | `Promise<void>`，不返回状态 | 每步返回完整树 + 截图 |
| 读状态默认返回 | **只有元素树文本，且默认是相对上一次的 diff**；`disableDiff` 才给全树 | 全树（最多 1200 个元素）+ 截图 |
| 截图 | 只给 `file://` 路径，模型要看时显式 `emitImage`；整段会话只看了一次 | 每次都带 |
| 动作后的等待 | 读状态时如刚做过动作，自动等约 1 秒；有加载指示时最多再等 5 秒 | 每步固定等 0.6 秒 |
| 确认 | 不逐次确认，靠提示词里的确认规则 | 插件 MCP 工具一律中风险，逐个工具确认 |

真实记录中的返回量：动作后的 diff 231–883 字符；全树约 3.9k 字符；截图一次 65 万字符（base64），只在明确需要时取。

## 元素树格式

全树：

```
Window: "Clash Verge", App: Clash Verge.
0 standard window Clash Verge, Secondary Actions: Raise
	1 scroll area
		2 HTML content Description: Clash Verge, URL: tauri://localhost/settings
			6 button 首 页
			32 switch (settable, boolean) on
			57 combo box (collapsed, settable) Value: Info, Secondary Actions: Expand
			60 text field (settable) 7890
```

- 制表符缩进表示层级，深度优先编号。
- 角色用简短英文描述（`standard window`、`container`、`text`、`text field`、`switch`、`combo box`、`HTML content`…），不是 `AXButton` 这类原名。
- 状态放括号（`settable`、`collapsed`、开关的 on/off），之后是标题、`Description:`、`Value:`、`Secondary Actions:`。

diff：

```
The following is a diff from the previous accessibility tree for Window: "Clash Verge" with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.
Removed element IDs: 15, 17-26, 28, 30-106
~		13 HTML content Description: Clash Verge, URL: tauri://localhost/settings
+				17 button 首 页
The focused UI element is 24 button 设 置
```

- 编号变化也算“改变”（`~`），所以没列出的行编号不变，模型可以继续用旧编号。
- 删除的元素按旧编号合并成区间。
- 末尾给出焦点元素。
- 界面被用户或别处改动、编号失效时，只提示“重新读取状态”，不猜。

## 其他行为

- 窗口为目标（window2 API）：`get_window_state` 默认带截图、不带文字；macOS 现用的 `get_app_state` 默认只给文字。两代都是“按需取，不自动附带”。
- `get_app_state` 透明启动未运行的应用；应用可按显示名或 bundle id 指定，按名失败就用 bundle id 重试。
- 优先按元素编号操作，失败再按截图坐标；`perform_secondary_action` 只用元素列出的动作名，不猜。
- `paste`（text / md / html）走剪贴板，用完还原；长内容、富文本用它而不是逐字输入。

## 对我们的改造

1. **批量：** 新增 `run` 工具，一次执行多步（click / type_text / press_key / scroll / set_value / perform_action / drag / wait），最后返回一次状态。
2. **默认 diff：** 状态默认只返回相对上一次的变化；`full: true` 才给全树。
3. **默认不带截图：** `screenshot: true` 才截，JPEG、长边 1280 以内。
4. **格式对齐：** 简短角色名、括号状态、Secondary Actions、焦点元素。
5. **读得快：** 每个元素一次取全部属性（`AXUIElementCopyMultipleAttributeValues`），只对需要的角色取动作名。
6. **等待：** 读状态时离上次动作不足约 1 秒就补足；有忙碌 / 进度指示时再等，最多 5 秒。
7. **少确认：** 内置 `mc.computer-use` 插件（只认应用自带目录里的）的读取类工具（列应用、读状态、权限）定为低风险，不再逐次确认；动作类仍需确认，可本会话放行。
