# 服务器部署指南（免开机自动签到）

目标：登录态一次性同步到服务器后，**电脑关机数月，积分照领**。

已验证环境：腾讯云 Ubuntu 24.04（Asia/Shanghai 时区）/ Node v22 / 2C4G。

---

## 一、架构

```
本机（Windows，TraeWork 已登录）          服务器（Linux + Node ≥ 18）
─────────────────────────────           ─────────────────────────────
export_auth.js ──导出──▶ trae_auth.json ──scp──▶ ~/checkin/trae/ (chmod 600)
                                                  │
                                         cron 08:05 每天
                                                  ▼
                                    trae_checkin_server.js
                                      ├─ token <24h → ExchangeToken 刷新（自动回写）
                                      ├─ status 查询（已签跳过）
                                      └─ claim 领取 150-200 积分
```

---

## 二、部署步骤

### 1. 本机导出登录态

```powershell
# 以 TRAE 客户端为 Node 运行时执行导出
$env:ELECTRON_RUN_AS_NODE="1"
& "C:\...\TRAE SOLO CN\TRAE SOLO CN.exe" scripts\export_auth.js trae_auth.json
```

导出后用 PowerShell 补充 4 个硬件指纹字段（保证与客户端上报一致）：

```powershell
$j = Get-Content trae_auth.json -Raw | ConvertFrom-Json
$j.device.deviceInfoStatic | Add-Member -Force NotePropertyName DeviceBrand  -NotePropertyValue (Get-CimInstance Win32_ComputerSystem).Manufacturer
$j.device.deviceInfoStatic | Add-Member -Force NotePropertyName DeviceModel -NotePropertyValue (Get-CimInstance Win32_ComputerSystem).Model
$j.device.deviceInfoStatic | Add-Member -Force NotePropertyName DeviceCPU    -NotePropertyValue (Get-CimInstance Win32_Processor).Name
$j.device.deviceInfoStatic | Add-Member -Force NotePropertyName OSVersion   -NotePropertyValue ([System.Environment]::OSVersion.Version.ToString())
$j | ConvertTo-Json -Depth 10 | Set-Content trae_auth.json -Encoding UTF8
```

### 2. 上传

```powershell
ssh user@server "mkdir -p ~/checkin/trae ~/checkin/logs"
scp scripts/trae_checkin_server.js trae_auth.json user@server:~/checkin/trae/
ssh user@server "chmod 600 ~/checkin/trae/trae_auth.json"
```

### 3. 测试

```bash
ssh user@server "node ~/checkin/trae/trae_checkin_server.js"
# 预期输出（当天未签）：
# [..] token 有效至 ...
# [..] 签到成功！获得积分: 200
# {"status":"ok","action":"clicked","credits":200}
```

### 4. 配置 cron（北京时间 08:05）

```bash
( crontab -l 2>/dev/null;
  echo '5 8 * * * /usr/bin/node /home/<user>/checkin/trae/trae_checkin_server.js >> /home/<user>/checkin/logs/trae.log 2>&1'
) | crontab -
```

> 服务器若为 UTC 时区，北京时间 08:05 = UTC 00:05，cron 写 `5 0 * * *`。

---

## 三、验证与监控

```bash
# 查看最近日志
tail -20 ~/checkin/logs/trae.log

# 日志判定
#   "token 已刷新"        → 刷新分支正常（首次出现在部署后第 6-7 天）
#   "签到成功" / skip     → 正常
#   "ERROR:"              → 失败，见下方排错
```

---

## 四、维护日历

| 时间点 | 动作 | 原因 |
|---|---|---|
| 部署后第 1 天 | 看日志确认首次服务器 claim 成功 | 验证服务器 IP 环境放行 |
| 部署后第 6-7 天 | 看日志确认 "token 已刷新" | ExchangeToken 分支首次自然触发 |
| 每 5-6 个月 | 重新导出同步 `trae_auth.json` | refreshToken 到期（正常 rotate 会滚动续期，可能更久） |
| 客户端大版本升级后 | 若突然 9004/9074，重新导出并核对 `x-app-version` | 版本号/协议可能变更 |

---

## 五、排错

| 症状 | 处理 |
|---|---|
| `ExchangeToken 失败 HTTP 4xx` | refreshToken 过期（超 6 个月未同步）或客户端协议升级 → 本机重登 + 重新导出 |
| `claim 失败: 当前参与用户太多` | `trae_auth.json` 中 deviceId/appVersion 与客户端升级后不一致 → 重新导出 |
| `status 查询失败 HTTP 401` | token 失效且刷新失败 → 重新导出同步 |
| 服务器出网不通 | 检查安全组出站规则，需放行 `api.trae.cn`（443） |
| cron 没跑 | `grep CRON /var/log/syslog`；确认 crontab 已写入、node 路径正确 |

---

## 六、安全清单

- [x] `trae_auth.json` 服务器 `chmod 600`
- [x] `trae_auth.json` 已入 `.gitignore`，永不提交
- [x] 脚本输出不含 token
- [ ] SSH 建议密钥登录 + 安全组限制来源 IP（服务器通用加固）
