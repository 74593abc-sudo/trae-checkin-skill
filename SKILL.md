---
name: trae-checkin
display_name: TRAE 每日自动签到
display_name_en: TRAE Daily Check-in
description: TRAE（TraeWork CN）每日签到自动化 Skill，接口直签，无需打开客户端。支持本机运行与服务器长期免开机部署（token 自动刷新）。当用户说"自动签到 TRAE / TRAE 签到 / 领积分 / 部署到服务器 / 不开机签到 / token 过期了"时使用。原理是解密本机 TraeWork 登录态，携带客户端同款设备指纹直接调用官方签到接口领取积分（每日 150-200 积分），并支持 ExchangeToken 自动续期实现服务器独立运行。
description_zh: 解密本机 TraeWork 登录态，携带逆向确认的设备指纹调用官方接口完成每日签到（无需打开客户端），支持本地定时与服务器免开机部署（token 7 天自动刷新，半年免维护）。
description_en: Auto check-in for TRAE (TraeWork CN) via the official API using the locally decrypted auth state with client-identical device headers. Supports local scheduling and server deployment with automatic token refresh (runs unattended for months).
category: 自动化
version: 1.0.0
author: 74593abc-sudo
---

# TRAE 每日自动签到（接口直签 · 服务器免开机 · token 自动续期）

TRAE 每日签到本质是一次**带设备指纹校验的 HTTP 接口请求**，不需要打开客户端，也不需要模拟任何 GUI 操作。

本 Skill 基于对 TraeWork CN 客户端 v0.1.65 的完整逆向（登录态加密、设备指纹、签到接口、token 刷新协议），全部接口已实测验证。

> 面向用户的完整说明（快速开始 / 部署 / 维护日历 / FAQ）见 `README.md`。
> 接口规范、加密算法、字段与错误码见 `@references/api-spec.md`。
> 服务器部署完整步骤见 `@references/deployment.md`。
> 本文件只保留元数据与代理执行所需关键信息。

## 关键事实（已实测验证，Windows 11 + TraeWork CN v0.107.1 外壳 / v0.1.65 逻辑层）

- **登录态文件（AES-128-CBC 加密）**：`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`
  - key `iCubeAuthInfo://icube.cloudide` → accessToken（7 天有效）/ refreshToken（约 6 个月有效）
  - key `iCubeAuthInfo://icube-dc:{deviceId}` → 设备密钥对（EC P-256，token 刷新签名用）
- **解密算法**：base64 → 偏移取 key → SHA-512 派生 AES 密钥 + IV（详见 api-spec.md，脚本已内置）
- **签到接口**（域名 `https://api.trae.cn`）：
  - `POST /trae/api/v2/ug/checkin_credits/status` — 查询是否已签（幂等）
  - `POST /trae/api/v2/ug/checkin_credits/claim` — 领取积分
- **必须携带的设备头**（缺失即被拒，返回 9004/9074）：
  - `x-device-id`: aha 数字设备 ID（**不是** machineid UUID；从 aha 日志 `InitDeviceId` 提取）
  - `x-app-version`: `0.1.65`（应用逻辑版本，**不是** Electron 外壳版本 1.107.1）
  - `x-device-brand` / `x-device-type` / `x-os-version`
  - 请求体必须含 `{"req_source": 2}`
- **token 刷新**：`POST {host}/trae/api/v3/oauth/ExchangeToken`，携带 ECDSA-SHA256 设备签名（DeviceProof），可脱离客户端续期 token

## 自带脚本（`scripts/`，零第三方依赖，Node ≥ 18 内置 fetch/crypto）

| 脚本 | 用途 | 登录态来源 |
|---|---|---|
| `checkin.js` | 本机签到（读本地加密登录态） | storage.json 自动解密 |
| `run_checkin.cmd` | Windows 双击入口（以 TRAE exe 为 Node 运行时） | 同上 |
| `export_auth.js` | 导出登录态+密钥对+设备指纹 → `trae_auth.json` | storage.json |
| `trae_checkin_server.js` | 服务器版：token 自动刷新 + 签到 | `trae_auth.json` |

**输出约定**：人类可读日志 + 最终一行 JSON（`{"status":"ok","action":"clicked|skip_already_signed|...","credits":N}`）；退出码 0 成功/已签、1 失败。**任何输出不含 token**。

## 调用本 Skill 时的搭建流程（照做即可）

### 场景 A：本机自动化

1. **前置检查**：TraeWork CN 已安装并登录；确认 `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` 存在。
2. **落位脚本**：复制 `scripts/` 到稳定路径；`run_checkin.cmd` 中 `TRAE_EXE` 改为本机安装路径。
3. **验证**：运行一次，`--check` 语义（先 status 后 claim 的幂等设计天然安全）。预期输出：
   - 未签 → `Check-in successful! Credits: 200`
   - 已签 → `Already checked in today.`
4. **定时**：Windows 任务计划程序 `schtasks /create /tn "TraeWork签到" /tr "...\run_checkin.cmd" /sc daily /st 09:00`。

### 场景 B：服务器免开机部署（推荐）

1. 本机跑 `export_auth.js` 导出 `trae_auth.json`（含硬件指纹，需 PowerShell 补充 4 个字段，见 deployment.md）。
2. 上传 `trae_checkin_server.js` + `trae_auth.json` 到服务器（`chmod 600`）。
3. 服务器 `node trae_checkin_server.js` 测试（Node ≥ 18）。
4. cron：`5 8 * * * /usr/bin/node ~/checkin/trae/trae_checkin_server.js >> ~/checkin/logs/trae.log 2>&1`
5. 详见 `@references/deployment.md`。

## 安全约束（务必遵守）

- 只读登录态文件，绝不修改、删除、外传 `accessToken` / `refreshToken` / 设备密钥对。
- **`trae_auth.json` 永不入 Git**（.gitignore 已排除）；服务器上必须 `chmod 600`。
- 任何输出（终端/日志/汇报）不得包含真实 token；脚本已脱敏，代理也不要回显凭据。
- token 刷新后 refreshToken 会 rotate，脚本已自动回写；**手动复制旧文件会覆盖新 refreshToken 导致锁死**。
- 同一登录态本机与服务器可并存签到（幂等，已签自动跳过）。

## 排错要点（详见 README FAQ）

| 症状 | 原因 | 处理 |
|---|---|---|
| `code 9004` 参数错误 | 缺设备头或 `req_source` | 用本 Skill 脚本（已内置全套头） |
| `code 9074` 参与用户太多 | `x-device-id`/`x-app-version` 错误 | 用 aha 数字设备 ID + `0.1.65` |
| `ERROR: No auth data found` | 未登录 / 换了客户端目录 | 打开 TraeWork 重新登录 |
| ExchangeToken 失败 | refreshToken 过期（约 6 个月）或设备指纹变更 | 本机重登 → 重新导出同步 |
| 输出乱码 | cmd 文件编码与系统代码页不符 | UTF-8 代码页(65001)用 UTF-8 文件；GBK 用 ANSI |
