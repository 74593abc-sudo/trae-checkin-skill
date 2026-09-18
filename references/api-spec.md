# 接口与协议规范（TRAE 每日签到）

本文件是 TraeWork CN 客户端 v0.1.65（外壳 v1.107.1）的逆向成果，全部接口已在 Windows 11 / 腾讯云 Ubuntu 双环境实测验证（2026-09）。

供 Skill 执行、排错与后续客户端版本升级时对照使用。

---

## 1. 登录态存储与解密

### 1.1 存储位置

`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`

| key | 内容 |
|---|---|
| `iCubeAuthInfo://icube.cloudide` | 登录态（token / refreshToken / 账户信息） |
| `iCubeAuthInfo://icube-dc:{deviceId}` | 设备密钥对（EC P-256，token 刷新签名用） |
| `iCubeAuthInfo://usertag` | 用户标签（签到用不到） |

`{deviceId}` 为 aha 数字设备 ID（见 §3.1）。

### 1.2 解密算法（AES-128-CBC，密钥派生自 SHA-512）

```
输入: base64 字符串
  ├─ bytes[6..38]  → 32 字节 keySeed
  ├─ SHA-512(keySeed)                     → sha (64B)
  ├─ xorTable = ure ^ dre (64B, 常量表内置脚本)
  ├─ SHA-512(sha || xorTable)             → hash
  │     ├─ hash[0..16]  → AES-128 密钥
  │     └─ hash[16..32] → IV
  ├─ bytes[38..]   → 密文
  └─ AES-128-CBC 解密 → 明文[64..] 为 JSON
```

常量表 `ure`/`dre`（64 字节各）已内置在所有脚本中，勿改动。

### 1.3 登录态字段（解密后）

```json
{
  "token": "<JWT, ~1000 字符>",           // 7 天有效
  "refreshToken": "<61 字符>",            // 约 6 个月有效，刷新时 rotate
  "expiredAt": "2026-09-24T18:47:25.699Z",
  "refreshExpiredAt": "2027-03-09T18:47:25.699Z",
  "host": "https://api.trae.cn",
  "userId": "<your-user-id>",
  "userRegion": { "region": "CN", "_aiRegion": "CN" },
  "account": { "...": "用户资料" }
}
```

---

## 2. 签到接口

基础地址：`https://api.trae.cn`（以登录态 `host` 字段为准）

### 2.1 请求头（关键：设备指纹校验）

```
Authorization: Cloud-IDE-JWT <token>
Content-Type: application/json
X-User-Region: CN
x-device-id: <aha 数字设备 ID>        ← 不是 machineid UUID！
x-app-version: 0.1.65                 ← 应用逻辑版本，不是外壳 1.107.1
x-device-brand: <厂商，如 <厂商，如 Lenovo>>
x-device-type: windows
x-os-version: <如 <如 10.0.22631.0>>
```

请求体：`{"req_source": 2}`（2 = SOLO/Lite 客户端）

### 2.2 状态查询（只读，幂等）

```
POST /trae/api/v2/ug/checkin_credits/status
```

```json
{
  "checked_in": false,       // 今日是否已签
  "enable": true,            // 签到功能开关
  "credits": 150,            // 签到可得积分
  "extra_credits": 50,       // 连续签到加成
  "code": 0
}
```

### 2.3 领取签到（写）

```
POST /trae/api/v2/ug/checkin_credits/claim
```

成功：`{"code":0, "data":{"credits":200}}`
已签：status 先查即跳过；直接 claim 会返回业务错误码。

### 2.4 错误码

| code | 含义 | 根因 |
|---|---|---|
| `9004` | 提交的订单参数不正确 | 缺设备头 / 缺 `req_source` |
| `9074` | 当前参与用户太多 | `x-device-id` 或 `x-app-version` 与服务端预期不符（伪装身份校验失败） |
| HTTP 401 | 登录态过期 | token 7 天到期，需刷新或重新登录 |

> 9004/9074 均为**设备身份校验失败**的表现，不是真的限流。修正设备头后立即恢复。

---

## 3. 设备身份

### 3.1 aha 数字设备 ID

- 格式：纯数字（15 位左右），例 `<your-device-id>（15 位左右纯数字）`
- 与 machineid（UUID 格式）**不同**，由 aha 设备服务（字节系）生成并注册
- 获取方式（按优先级）：
  1. storage.json 中 `iCubeAuthInfo://icube-dc:` 前缀 key 的后缀
  2. aha 日志：`%APPDATA%\TRAE SOLO CN\logs\aha_log\aha_electron_YYYY.MMDD.log` 中 `InitDeviceId ... device_id: (\d+)`
  3. 设备 ID 长期稳定（实测 4 天+不变），可安全硬编码兜底

### 3.2 应用版本号

| 版本 | 值 | 来源 |
|---|---|---|
| 应用逻辑版本 | `0.1.65` | `resources/app/node_modules/@byted-icube/solo-lite` 版本，接口头用这个 |
| Electron 外壳版本 | `1.107.1` | `resources/app/package.json`，**不要**用这个 |

---

## 4. Token 刷新协议（ExchangeToken）

脱离客户端长期运行的核心。服务端校验设备签名，签名通过即视为同一可信设备。

### 4.1 端点

```
POST {host}/trae/api/v3/oauth/ExchangeToken
Authorization: Cloud-IDE-JWT <当前 token>
Content-Type: application/json
```

### 4.2 请求体

```json
{
  "ClientID": "en1oxy7wnw8j9n",
  "ClientSecret": "",
  "RefreshToken": "<refreshToken>",
  "DeviceInfo": {
    "DeviceID": "<aha 数字设备 ID>",
    "MachineID": "<machineid UUID>",
    "PlatformCode": "SOLO_PC",
    "DeviceType": "PC",
    "DeviceName": "<Windows 用户名>",
    "DeviceModel": "<机型，如 <机型，如 Legion R9000P>>",
    "ClientVersion": "0.1.65",
    "DevicePublicKey": "<EC P-256 公钥 PEM>",
    "DeviceBrand": "<厂商>",
    "DeviceCPU": "<CPU 型号>",
    "OSInfo": "windows",
    "OSVersion": "<OS 版本>"
  },
  "DeviceProof": { "Signature": "...", "Timestamp": 0, "Nonce": "..." },
  "IDEVersion": "0.1.65"
}
```

- `ClientID`：SOLO 客户端 fallback 值 `en1oxy7wnw8j9n`（TRAE 完整版为 `ono9krqynydwx5`）
- `DeviceInfo` 建议**导出本机真实硬件指纹**保证一致性

### 4.3 DeviceProof 签名算法

```js
timestamp = Math.floor(Date.now() / 1000)
nonce     = randomBytes(16).toString('hex')
payload   = ["POST", "/trae/api/v3/oauth/ExchangeToken",
             clientId, refreshToken, String(timestamp), nonce].join("\n")
signature = ECDSA_SIGN_SHA256(privateKeyPEM, payload).base64()
```

私钥从 storage.json 的 `iCubeAuthInfo://icube-dc:{deviceId}` 解密获得（§1.2 同套算法）。

### 4.4 响应

```json
{ "Result": {
    "Token": "<新 accessToken>",
    "RefreshToken": "<新 refreshToken，rotate！>",
    "TokenExpireAt": 0, "TokenExpireDuration": 0,
    "RefreshExpireAt": 0
} }
```

> **refreshToken 每次 rotate**：刷新后必须立即持久化新值，否则旧 refreshToken 失效导致无法再刷新。

### 4.5 刷新策略

token 剩余有效期 < 24 小时时触发刷新（`trae_checkin_server.js` 已内置）。

---

## 5. 与客户端的关系

- 客户端本身**不会自动签到**（实测每天仅用户手动触发一次 claim）
- 本机客户端与外部脚本可并存：同一 token 签到幂等，已签自动跳过
- 客户端升级可能改变：逻辑版本号（`x-app-version`）、加密算法常量、接口路径 —— 升级后如突然 9004/9074，优先核对版本号
