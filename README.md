# TRAE 每日自动签到 Skill

TraeWork CN 每日签到的全自动化方案：**接口直签，无需打开客户端；支持服务器部署，电脑关机积分照领。**

- 每日领取 150-200 积分（含连续签到加成）
- 零第三方依赖（Node ≥ 18 或直接用 TRAE 客户端做运行时）
- token 7 天自动刷新（ExchangeToken + 设备签名），服务器半年免维护
- 本机 / 服务器可并存，幂等安全

> 本 Skill 基于对 TraeWork CN 客户端的完整逆向，所有接口双环境实测验证（2026-09）。
> 技术细节见 [references/api-spec.md](references/api-spec.md)，服务器部署见 [references/deployment.md](references/deployment.md)。

---

## 快速开始（本机）

### 前置条件

1. 已安装 TraeWork CN（TRAE SOLO CN）并登录
2. 无需安装 Node.js —— 脚本直接以 TRAE 客户端为 Node 运行时

### 30 秒上手

1. 修改 `scripts/run_checkin.cmd` 中的 `TRAE_EXE` 为本机 TRAE 安装路径
2. 双击运行，预期输出：

```
Check-in successful! Credits: 200        ← 今日未签，已领取
Already checked in today. Credits: 200   ← 今日已签，安全跳过
```

### 每日自动（Windows 任务计划程序）

```powershell
schtasks /create /tn "TraeWork签到" /tr "D:\path\to\run_checkin.cmd" /sc daily /st 09:00
```

---

## 服务器部署（免开机，推荐）

电脑关机、出门旅行，积分照领。完整步骤见 [references/deployment.md](references/deployment.md)，核心三步：

```bash
# 1. 本机导出登录态（含设备密钥对与硬件指纹）
node scripts/export_auth.js trae_auth.json

# 2. 上传服务器
scp scripts/trae_checkin_server.js trae_auth.json user@server:~/checkin/trae/

# 3. 配 cron（北京时间 08:05）
# 5 8 * * * /usr/bin/node ~/checkin/trae/trae_checkin_server.js >> ~/checkin/logs/trae.log 2>&1
```

服务器版脚本自动处理：token 过期前 24h 触发 ExchangeToken 刷新 → rotate 的 refreshToken 回写 → 签到。

---

## 工作原理

```
storage.json (AES-128-CBC 加密)
  ├─ iCubeAuthInfo://icube.cloudide ────────▶ accessToken (7天) / refreshToken (6个月)
  └─ iCubeAuthInfo://icube-dc:{deviceId} ──▶ EC P-256 设备密钥对
                    │
                    ▼ 解密（SHA-512 派生密钥，算法内置脚本）
        携带客户端同款设备头调用官方接口
  ├─ POST /trae/api/v2/ug/checkin_credits/status   （幂等查询）
  ├─ POST /trae/api/v2/ug/checkin_credits/claim    （领取积分）
  └─ POST /trae/api/v3/oauth/ExchangeToken         （token 续期，ECDSA 设备签名）
```

**为什么社区脚本会失败（9004/9074）**：服务端校验设备身份。必须携带 aha 数字设备 ID（而非 machineid UUID）、应用逻辑版本号 `0.1.65`（而非外壳版本 `1.107.1`）及请求体 `{"req_source":2}`。本 Skill 的逆向结论全部内置在脚本中。

---

## 文件结构

```
├── SKILL.md                        技能主文件（代理执行要点）
├── README.md                       本文档
├── scripts/
│   ├── checkin.js                  本机签到（自动解密本地登录态）
│   ├── run_checkin.cmd             Windows 双击入口
│   ├── export_auth.js              登录态导出（服务器部署用）
│   └── trae_checkin_server.js      服务器版（token 自动刷新 + 签到）
└── references/
    ├── api-spec.md                 接口与协议规范（逆向成果）
    └── deployment.md               服务器部署完整指南
```

---

## 维护日历

| 时间点 | 动作 |
|---|---|
| 部署后第 1 天 | 查看服务器日志，确认首次自动 claim 成功 |
| 部署后第 6-7 天 | 确认日志出现 "token 已刷新"（ExchangeToken 分支首次触发） |
| 每 5-6 个月 | 本机重新导出 `trae_auth.json` 同步到服务器 |
| TRAE 客户端大版本升级后 | 若签到突然报错，重新导出（版本号可能变更） |

---

## FAQ

**Q: token 会不会突然失效？服务器需要经常维护吗？**
A: accessToken 7 天有效，脚本在到期前 24h 自动用 refreshToken 换新；refreshToken 约 6 个月有效且每次刷新滚动续期。正常情况下半年看一眼日志即可。

**Q: 本机和服务器同时跑会重复领取吗？**
A: 不会。签到接口幂等，任何一方发现已签（`checked_in: true`）直接跳过。

**Q: 报错 9074「当前参与用户太多」是限流吗？**
A: 不是。这是设备身份校验失败的伪装文案——检查 `x-device-id`（应为 aha 数字 ID）与 `x-app-version`（应为 0.1.65）。

**Q: 换电脑/重装系统后怎么办？**
A: 本机版无需处理（自动从新登录态读取）；服务器版需重新跑 `export_auth.js` 导出同步（deviceId 与密钥对会变化）。

**Q: 这样做有什么风险？**
A: 接口为 TraeWork 客户端同款官方接口，行为与手动点击签到一致；但自动化调用理论上受用户协议约束，请自行评估。建议仅个人账号使用，勿对外提供服务。

---

## 安全说明

- 登录态文件只读，绝不修改
- `trae_auth.json`（导出的凭据）**永不入 Git**，服务器 `chmod 600`
- 所有脚本输出自动脱敏，不打印 token
- 私钥/凭据请勿通过公共渠道传输

## License

MIT（仅供个人学习与自动化使用，请遵守 TRAE 用户协议）