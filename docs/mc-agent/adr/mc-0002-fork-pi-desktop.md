# MC-ADR-0002: 基于 PI-Desktop Fork 二次开发

**Status:** Accepted（范围限选型方向；新增功能细节仍为待评审建议）
日期：2026-10-14。
决策人：产品负责人。
替代：[MC-ADR-0001](mc-0001-chatgpt-architecture-pi-kernel.md) 的实现底座、目录、协议、依赖与存储选择；旧文保留为历史，不再作为当前实现约束。

## 背景

mc-agent 面向工作室、OPC 和多项目开发用户，差异在项目文档、资源及开发流程管理。自建完整桌面 Agent 会重复实现基础能力，推迟验证核心价值。

用户已接受开源，并明确选择 Fork PI-Desktop 二次开发，现阶段只分析和完善文档。

Fork 已建立：`origin` 为 kylinmac/mc-agent，`upstream` 为 vastsa/PI-Desktop；建立时本地 main 位于上游 `a20a9ca`（0.20.1）。

## 决定

1. 采用 PI-Desktop 作为产品底座，保留上游已有能力，在项目管理相关路径做增量扩展。
2. 沿用 React Renderer、Electron Main、Rust Host Core、Node Agent runtime 的现有分工及 packages/host-runtime 等已有模块。
3. 允许沿用上游 pi-ai、pi-agent-core、pi-coding-agent 依赖，不再执行旧版“排除 coding-agent”的限制。
4. 沿用上游 IPC／RPC、会话标识、数据与权限机制，不新建 Codex 风格 thread/start、turn/start 协议。
5. 用户接受 LGPL-3.0 开源方向。正式分发时保留许可、署名及对应源码，并审查依赖和素材。
6. 文档阶段不安装或运行产品、不修改业务代码；进入开发由用户明确决定。

## 保留的原则

UI 不直接执行特权工具；Agent 循环与窗口分离；执行归属不能跟随当前选中项目漂移；权限与数据安全不因二次开发而削弱。

## 备选与代价

- 从 Pi 核心自建：控制力强，但基础产品工作量大，本阶段不选。
- 只做插件：适合独立面板和工具，但项目身份、任务数据及启动流程需要共同演进，当前选择 Fork；局部功能仍可复用插件扩展点。
- Fork：更快继承功能，但需跟进上游更新、保持兼容并承担 Rust 与 TypeScript 两侧维护。

## 后果

需求拆为继承能力与新增项目管理能力；架构、协议、原型和验收计划同步更新。正式开发前锁定可构建版本并检查数据迁移。

## 重访条件

若上游加入同等功能、关键扩展无法兼容、维护成本明显超出收益，再评估向上游贡献或独立插件路线。
