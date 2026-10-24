# iOS 26 助理改版发布交接

状态：代码完成、自动化验收通过，尚未提交、推送或部署。iOS 真机验收与签名归档需在 Xcode 26 环境完成。

## 发布范围

- 最低系统统一为 iOS 26，主 App 与 Share Extension 均不保留旧系统兼容分支。
- iPhone 一级入口为「小驳 / 待处理 / 消息」；每个入口拥有独立导航状态，助理草稿与消息草稿不串台。
- 小驳首页使用今日脉络、草稿卡、工具回执、每日 09:00 简报与 21:00 收尾。
- 待办、日程、委派、审批和后台运行统一投影为 `PersonalTask`，底层事实源保持不变。
- Apple 本地设备桥支持日历、提醒事项和联系人。读取按系统权限执行；写入必须在 iOS 前台逐次确认。
- Share Extension 默认分享给小驳；App Intents、Shortcuts 和语音入口通过 App Group 队列交给主 App。
- 产物中心只读投影 `turn.files`、委派记录和 Share capture，不创建第二份索引；支持来源引用、预览、分享和继续加工。
- Liquid Glass 只用于导航、Tab、输入和悬浮操作；正文与列表继续使用实体内容表面。

## 数据与协议迁移

1. `AssistantState` 新字段均为可选，旧客户端可忽略；新客户端对旧网关保留空态和旧审批回退。
2. `PersonalTask`、`DraftCard`、`DayThreadEvent` 和 `Artifact` 都是派生投影，不迁移或重写待办、日程、委派、会话与收件箱事实源。
3. 设备桥只在已鉴权且声明 `device_bridge` 的同租户连接间单播。审计不记录联系人正文、日历备注、提醒正文或凭据。
4. Share 文件存入租户 `stateDir` 的受控快照区，通过收件箱中的 `path + sha` 授权读取；不把上传临时文件放进 Agent 可写工作区。
5. App Group 使用现有 `group.ai.jiebo.ipad`。归档前确认主 App 与 Share Extension 的签名能力均包含该组。

## 推荐发布顺序

1. 先部署兼容新可选字段、Share HTTP 路由和 Device Bridge 的网关。
2. 再部署 Web；Web 与旧 iOS 客户端继续兼容。
3. 用 Xcode 26 在 iOS 26 真机完成下方验收后，再分发新 App 与 Share Extension。
4. 观察设备审计中的状态计数、Share 上传错误率、助理收件箱积压和 APNs 异常，不采集正文。

不需要数据库迁移。回滚 App 不会破坏事实源；若回滚网关，应同时停止分发依赖 Device Bridge 和 Share Assistant 新路由的 App 版本。

## 已完成的自动化验收

- `npm test`
- `npm run lint`（零错误；仓库既有 warning 保留）
- `npm run format:check`
- `npm run build`
- `npm run typecheck:scripts`
- `npm run ci:smoke`（10 组全通过）
- `npm run smoke:assistant`
- `npm run smoke:im`
- `SWIFT_BIN=… npm run check:ios-protocol`
- Device Bridge、Share capture、Artifact Projection、默认协作群并发相关定向测试
- `git diff --check`
- 新增与修改文件的 IDE lint

独立评审发现并已修复：设备写入超时与幂等竞态、iPad 确认承载、同参数独立写入误合并、默认协作群并发重复创建、Share 上传 symlink TOCTOU、Canvas 复合扩展名误判。

## 真机与发布前验收

- [ ] iPhone：三个一级入口切换后导航栈、键盘、草稿和角标互不串台。
- [ ] iPhone/iPad：日历与提醒写入均出现中文确认；超时后允许不会落盘；拒绝后可重新发起。
- [ ] 多设备：iPad 不可确认或忙时，请求只在一个可确认设备继续，不重复弹窗或重复写入。
- [ ] 权限：日历、提醒、联系人分别覆盖首次允许、拒绝、系统设置撤销后的状态。
- [ ] Share：文字、网页、图片、普通文件；离线排队、前台 drain、重复 `clientId`、大文件和伪造 MIME。
- [ ] Shortcuts/Siri：三个 App Intent 的中文短语、锁屏与解锁后跳转。
- [ ] 产物中心：文本、图片、PDF、Canvas、委派产物、链接来源与“让小驳继续处理”。
- [ ] Dynamic Type、VoiceOver、减弱动态效果、横竖屏和 iPad 多任务。
- [ ] Release 签名、App Group、日历/提醒/联系人用途说明及 Share Extension entitlements。

## 已知外部条件

- Linux 环境不能执行 Xcode 构建、代码签名、真机权限和 App Intents 系统注册验收。
- `smoke:ios` 需要可用的 `JIEBO_WS_URL`；本次未连接线上或测试网关。
- 本交接不授权提交、推送或部署，发布动作需另行执行。
