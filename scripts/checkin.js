const fs = require('fs');
const crypto = require('crypto');

const HP = 16, q8_AES128 = 16, WP = HP, rh = 64, Rv = 32, VP = 64, Em = 6;
const ure = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const dre = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

async function sha512(data) {
  const h = await crypto.subtle.digest('SHA-512', data);
  return new Uint8Array(h);
}
function xorArrays(a, b, n) {
  const r = new Uint8Array(n);
  for (let i = 0; i < n; i++) r[i] = a[i] ^ b[i];
  return r;
}

async function decrypt(b64) {
  const t = new Uint8Array(Buffer.from(b64, 'base64'));
  const key = t.slice(Em, Em + Rv);
  const sha = await sha512(key);
  const xor = xorArrays(ure, dre, VP);
  const comb = new Uint8Array(rh + VP);
  comb.set(sha, 0);
  comb.set(xor, rh);
  const hash = await sha512(comb);
  const aesKey = hash.slice(0, q8_AES128);
  const iv = hash.slice(q8_AES128, q8_AES128 + WP);
  const ct = t.slice(Rv + Em);
  const ck = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CBC' }, false, ['decrypt']);
  const dec = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, ct));
  return new TextDecoder().decode(dec.slice(rh));
}

// 从 aha 日志中提取数字设备 ID（aha_electron_YYYY.MMDD.log 记录了 InitDeviceId）
function extractDeviceIdFromAhaLogs(appData) {
  const logDir = `${appData}\\TRAE SOLO CN\\logs\\aha_log`;
  let files = [];
  try { files = fs.readdirSync(logDir).filter(f => /^aha_electron_/.test(f)).sort().reverse(); } catch (e) { return null; }
  for (const f of files.slice(0, 7)) { // 只扫最近 7 个日志文件
    try {
      const content = fs.readFileSync(`${logDir}\\${f}`, 'utf8');
      const m = content.match(/InitDeviceId[^\n]*device_id: (\d+)/);
      if (m) return m[1];
    } catch (e) { /* 文件被占用等情况，跳过 */ }
  }
  return null;
}

async function main() {
  const appData = process.env.APPDATA;
  if (!appData) { console.log('ERROR: APPDATA environment variable not set'); return; }
  const storagePath = `${appData}\\TRAE SOLO CN\\User\\globalStorage\\storage.json`;
  const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const enc = storage['iCubeAuthInfo://icube.cloudide'];
  if (!enc) { console.log('ERROR: No auth data found'); return; }
  const auth = JSON.parse(await decrypt(enc));
  if (!auth.token) { console.log('ERROR: No token in auth data'); return; }

  const headers = {
    'Authorization': `Cloud-IDE-JWT ${auth.token}`,
    'Content-Type': 'application/json',
  };
  if (auth.userRegion?.region) headers['X-User-Region'] = auth.userRegion.region;

  // 补齐客户端同款设备头（对照客户端日志逆向确认的真实值）
  // x-device-id 必须是 aha 数字设备 ID（非 machineid UUID）
  // x-app-version 是应用逻辑版本 0.1.65（非 Electron 外壳版本 1.107.1）
  let deviceId = auth.deviceId;
  try {
    deviceId = deviceId || extractDeviceIdFromAhaLogs(appData);
  } catch (e) { /* ignore */ }
  if (!deviceId) {
    console.log('ERROR: 未能提取设备 ID（aha 日志不可读且 storage.json 无 icube-dc 记录），请打开一次 TRAE 客户端后重试');
    return;
  }
  headers['x-device-id'] = deviceId;
  headers['x-app-version'] = '0.1.65';
  headers['x-device-brand'] = 'Windows';
  headers['x-device-type'] = 'windows';
  headers['x-os-version'] = require('os').release();

  const body = JSON.stringify({ req_source: 2 });

  const statusUrl = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status';
  const claimUrl = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim';

  try {
    const statusRes = await fetch(statusUrl, {
      method: 'POST', headers, body
    });
    const status = await statusRes.json();
    if (status.checked_in) {
      console.log(`Already checked in today. Credits: ${status.credits}`);
      return;
    }
    if (!status.enable) {
      console.log('Check-in is not enabled');
      return;
    }
    const claimRes = await fetch(claimUrl, {
      method: 'POST', headers, body
    });
    const claim = await claimRes.json();
    if (claim.code === 0) {
      console.log(`Check-in successful! Credits: ${claim.data?.credits || 200}`);
    } else {
      console.log(`Check-in failed: ${claim.message || JSON.stringify(claim)}`);
    }
  } catch(e) {
    console.log('Error:', e.message);
  }
}

main().catch(e => console.log('Fatal:', e.message));
