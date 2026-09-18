#!/usr/bin/env node
/**
 * TRAE (TraeWork CN) 服务器版每日自动签到
 *
 * 功能：
 *   1. 读取同目录 trae_auth.json（登录态 + 设备密钥对，从本机一次性导出）
 *   2. accessToken 过期前 1 天内自动调用 ExchangeToken 刷新（ECDSA 设备签名）
 *   3. 查询签到状态 → 未签到则领取积分（每天 150-200 积分）
 *   4. 刷新后回写 trae_auth.json（rotate 的 refreshToken 必须保存）
 *
 * 运行：node trae_checkin_server.js [trae_auth.json 路径]
 * 退出码：0 成功/已签/跳过，1 失败
 * 安全：不打印任何 token；auth 文件请 chmod 600
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ---------- 配置 ----------
const AUTH_FILE = process.argv[2] || path.join(__dirname, 'trae_auth.json');
const STATUS_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status';
const CLAIM_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim';
const BALANCE_URL = 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage';

// ---------- 工具 ----------
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const fail = (msg) => { log(`ERROR: ${msg}`); process.exit(1); };

function loadAuth() {
  if (!fs.existsSync(AUTH_FILE)) fail(`找不到 ${AUTH_FILE}，请先从本机导出上传`);
  return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}
function saveAuth(cfg) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  fs.chmodSync(AUTH_FILE, 0o600);
}

// ---------- token 刷新（ExchangeToken + ECDSA 设备签名，逆向自客户端 v0.1.65） ----------
function deviceProof(clientId, refreshToken, privateKeyPEM) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = ['POST', '/trae/api/v3/oauth/ExchangeToken', clientId, refreshToken, String(timestamp), nonce].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(payload), privateKeyPEM).toString('base64');
  return { Signature: signature, Timestamp: timestamp, Nonce: nonce };
}

async function refreshToken(cfg) {
  const { auth, device } = cfg;
  const url = `${auth.host}/trae/api/v3/oauth/ExchangeToken`;
  const d = device.deviceInfoStatic;
  const body = {
    ClientID: device.clientId,
    ClientSecret: '',
    RefreshToken: auth.refreshToken,
    DeviceInfo: {
      DeviceID: device.deviceId,
      MachineID: device.machineId,
      PlatformCode: device.platformCode,
      DeviceType: d.DeviceType,
      DeviceName: d.DeviceName,
      DeviceModel: d.DeviceModel,
      ClientVersion: device.clientVersion,
      DevicePublicKey: device.keyPair.publicKeyPEM,
      DeviceBrand: d.DeviceBrand,
      DeviceCPU: d.DeviceCPU,
      OSInfo: d.OSInfo,
      OSVersion: d.OSVersion,
    },
    DeviceProof: deviceProof(device.clientId, auth.refreshToken, device.keyPair.privateKeyPEM),
    IDEVersion: device.clientVersion,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Cloud-IDE-JWT ${auth.token}` },
    body: JSON.stringify(body),
    timeout: 30000,
  });
  const data = await res.json().catch(() => null);
  if (res.status !== 200 || !data?.Result?.Token) {
    fail(`ExchangeToken 失败 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const r = data.Result;
  auth.token = r.Token;
  if (r.RefreshToken) auth.refreshToken = r.RefreshToken; // rotate，必须保存新的
  if (r.RefreshExpireAt) auth.refreshExpiredAt = new Date(r.RefreshExpireAt).toISOString();
  auth.expiredAt = r.TokenExpireDuration
    ? new Date(Date.now() + r.TokenExpireDuration).toISOString()
    : new Date(r.TokenExpireAt).toISOString();
  auth.tokenReleaseAt = new Date().toISOString();
  saveAuth(cfg);
  log(`token 已刷新，新过期时间: ${auth.expiredAt}`);
}

// ---------- 签到 ----------
function buildHeaders(cfg) {
  const { auth, device } = cfg;
  const d = device.deviceInfoStatic;
  const headers = {
    Authorization: `Cloud-IDE-JWT ${auth.token}`,
    'Content-Type': 'application/json',
  };
  if (auth.userRegion?.region) headers['X-User-Region'] = auth.userRegion.region;
  // 客户端同款设备头（缺失会被 9004/9074 拒绝）
  headers['x-device-id'] = device.deviceId;
  headers['x-app-version'] = device.clientVersion;
  headers['x-device-brand'] = d.DeviceBrand;
  headers['x-device-type'] = d.OSInfo;
  headers['x-os-version'] = d.OSVersion;
  return headers;
}

async function checkin(cfg) {
  const headers = buildHeaders(cfg);
  const body = JSON.stringify({ req_source: 2 });
  const statusRes = await fetch(STATUS_URL, { method: 'POST', headers, body });
  const status = await statusRes.json().catch(() => null);
  if (statusRes.status !== 200 || !status) fail(`status 查询失败 HTTP ${statusRes.status}`);

  if (status.checked_in) {
    log(`今日已签到。`);
    return { action: 'skip_already_signed', credits: 0 };
  }
  if (!status.enable) { log('签到功能未开启'); return { action: 'skip_disabled' }; }

  const claimRes = await fetch(CLAIM_URL, { method: 'POST', headers, body });
  const claim = await claimRes.json().catch(() => null);
  if (claim?.code === 0) {
    const got = claim.data?.credits ?? status.credits + (status.extra_credits || 0);
    log(`签到成功！获得积分: ${got}`);
    return { action: 'clicked', credits: got };
  }
  fail(`claim 失败: ${claim?.message || JSON.stringify(claim).slice(0, 200)}`);
}

// ---------- 积分余额（ide_user_ent_usage，客户端同款） ----------
async function fetchBalance(cfg) {
  try {
    const res = await fetch(BALANCE_URL, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ require_usage: true, req_source: 2 }),
    });
    const data = await res.json().catch(() => null);
    const s = data?.usage_summary;
    if (res.status !== 200 || !s) return null;
    return {
      total: s.total_amount,
      used: Math.round(s.consumed_amount),
      remaining: Math.round(s.total_amount - s.consumed_amount),
    };
  } catch (e) {
    return null; // 余额查询失败不影响签到
  }
}

// ---------- 主流程 ----------
async function main() {
  const cfg = loadAuth();
  const exp = Date.parse(cfg.auth.expiredAt);
  const needRefresh = !exp || exp - Date.now() < 24 * 3600 * 1000; // 过期前 1 天刷新
  if (needRefresh) {
    log('token 即将过期/已过期，执行 ExchangeToken 刷新...');
    await refreshToken(cfg);
  } else {
    log(`token 有效至 ${cfg.auth.expiredAt}`);
  }
  const [result, balance] = await Promise.all([checkin(cfg), fetchBalance(cfg)]);
  console.log(JSON.stringify({ status: 'ok', ...result, balance }));
}
main().catch((e) => fail(e.message));