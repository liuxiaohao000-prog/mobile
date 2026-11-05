# 研伴：患者入组与随访 App

本项目是无业务服务器的 Expo React Native App。患者档案、预筛记录、审核历史、同意记录、随访任务和联系历史保存在设备的 SQLCipher 数据库中；心电图与可选证明图片以 AES 加密后保存在应用私有目录。AI API Key 保存在系统 SecureStore。

## 最新预览版本与更新记录

**当前测试线：研伴 V2.0.10 Preview**（基于 V2.0.9 Preview 31；不是旧 `main` 分支的 0.1.x 系列）。

- V2.0.9 Preview 31 已实现今日/逾期随访速览、点击患者电话号码进入系统拨号器。
- **V2.0.10 Preview** 新增随访通知横幅、锁屏显示、震动的系统设置引导与诊断信息，保持 V2 原有提醒调度与通知渠道，不再使用错误的 v0.1.15 版本号。
- Android `versionCode`：25 → 26，`versionName`：`2.0.9-preview` → `2.0.10-preview`；安装包标签为 `v2.0.10-preview.<GitHub Actions run number>`。
- **重要**：Android 的通知总授权与“横幅/悬浮通知”“锁屏显示”“震动”是不同层级的设置。研伴可以申请总通知授权并创建高重要性渠道，但无法以运行时权限自动开启用户或厂商关闭的横幅及锁屏开关。请在「我的 → 随访提醒 → 检查横幅、锁屏和震动设置」中手动确认。锁屏仍受全局隐私政策、静音和免打扰影响。
- 版本差异、历史变更和测试风险详见 [docs/v2-preview.md](docs/v2-preview.md)。最新 APK 参见 [GitHub Releases](https://github.com/liuxiaohao000-prog/mobile/releases)；Preview 自动构建仍需真机验证。
- **升级时不得先卸载旧应用**，否则本地患者数据库与密钥可能丢失；升级前做好备份，校验签名一致。曾下载旧分支的 0.1.15 APK 的用户应以 V2 Preview 发布线为准。

**提交规则**：每次修改并推送新版本前，必须先读取本 README 和 `docs/v2-preview.md`，并在本次代码推送中同时更新两份文档，写清上一版本基线、实际变更、受影响设置、验证状态、版本号与 APK 下载方式；禁止仅改代码不改说明。CI 会检查版本文档包含当前 V2 版本号。

## 开发

需要 Node.js、npm，以及目标平台的原生工具链。

```powershell
npm install
npm run typecheck
npm start
```

## 安装到 Android

Windows 开发机需安装 Android Studio，并在 SDK Manager 中安装 Android SDK Platform 37、Build-Tools 37.0.0、Platform-Tools 和 NDK 27.1.12297006。设置 `ANDROID_HOME` 或 `mobile/android/local.properties` 的 `sdk.dir` 指向 Android SDK 目录。启动 Android 模拟器，或连接开启 USB 调试的 Android 设备，然后运行：

```powershell
npm run android
```

该命令会生成原生 Android 项目、编译并安装调试版 App。SQLCipher 必须通过原生构建启用，Expo Go 不适用于本 App。

## 安装到 iOS

iOS 原生构建需要 macOS 和 Xcode。当前 Windows 开发机无法本地编译或安装 iOS App。

## 首次使用

1. 安装并打开 App。
2. 在「我的」页面配置 OpenAI 兼容服务的 API Base URL、模型名称和 API Key。
3. 按需打开系统通知权限。
4. 在工作台或患者档案点击「新增或补录患者」，选择对应入口：
   - 「新增入组患者」从预筛开始。上传心电图后可提交 AI 辅助预筛；也可选择跳过 AI，不上传心电图并由授权人员人工核实资格。记录患者选择后，填写电话、组别，并从月历网格选择入组日期，再完成正式资格核实即可创建档案和随访任务。
   - 「添加已经入组患者」使用单页补录。姓名、电话、月历选择的入组日期和组别必填；年龄、性别、临床资料、心电图、历史同意证明、资格核实记录及说明都可选。保存后直接创建档案和 1、3、6、12 个月随访任务。

姓名和电话不会随 AI 请求发送。AI 请求会发送年龄、性别、填写的临床信息和心电图；请确保所用 AI 服务符合项目的数据处理授权要求。更新 App 时直接安装新版，不要先卸载；卸载 App 会移除本地资料和密钥。

## 当前 MVP 边界

- 数据只保存在当前设备，不提供多设备同步、服务器备份或跨设备去重。
- 本机操作人和正式资格核实人由使用者填写；MVP 记录其确认和说明，但不具备账号身份验证或角色权限系统。
- Android 随访提醒由本机 AlarmManager 闹钟滚动调度；到点由原生接收器发通知并安排下一次，不要求 App 常驻后台。应用启动、设备开机、更新系统时间/时区或 App 升级时会恢复计划。建议授予通知与“闹钟和提醒”精确闹钟权限；强行停止、设备关机、撤销权限或厂商后台限制仍可能影响送达。
- Android 的患者随访、即时测试和 1 分钟延迟测试共用原生通知渠道与通知投递代码；延迟测试交给 AlarmManager。通知按闹钟类别发布，一加设备的长波形震动使用 `USAGE_ALARM`，由系统依照闹钟/免打扰规则处理；用户关闭渠道震动或启用完全静音时，系统仍可能屏蔽震动。「我的」页面提供统一配置入口，并在折叠区域显示状态、上次延迟测试结果和测试操作。
- Android 可由本机 Android SDK 构建；iOS 需要 Mac/Xcode 或后续配置的远程构建环境。
