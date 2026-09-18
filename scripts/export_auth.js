// 导出 TRAE 登录态 + 设备密钥对 + 设备指纹到 trae_auth.json（供服务器部署）
// 安全约束：内容只写文件，不打印任何 token
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const HP = 16, q8_AES128 = 16, WP = HP, rh = 64, Rv = 32, VP = 64, Em = 6;
const ure = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const dre = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

async function sha512(d) { const h = await crypto.subtle.digest('SHA-512', d); return new Uint8Array(h); }
function xorArrays(a, b, n) { const r = new Uint8Array(n); for (let i = 0; i < n; i++) r[i] = a[i] ^ b[i]; return r; }
async function decrypt(b64) {
  const t = new Uint8Array(Buffer.from(b64, 'base64'));
  const key = t.slice(Em, Em + Rv);
  const sha = await sha512(key);
  const xor = xorArrays(ure, dre, VP);
  const comb = new Uint8Array(rh + VP);
  comb.set(sha, 0); comb.set(xor, rh);
  const hash = await sha512(comb);
  const aesKey = hash.slice(0, q8_AES128);
  const iv = hash.slice(q8_AES128, q8_AES128 + WP);
  const ct = t.slice(Rv + Em);
  const ck = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CBC' }, false, ['decrypt']);
  const dec = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, ct));
  return new TextDecoder().decode(dec.slice(rh));
}

async function main() {
  const appData = process.env.APPDATA;
  const storage = JSON.parse(fs.readFileSync(`${appData}\\TRAE SOLO CN\\User\\globalStorage\\storage.json`, 'utf8'));

  // 1. 登录态
  const auth = JSON.parse(await decrypt(storage['iCubeAuthInfo://icube.cloudide']));

  // 2. 设备密钥对（按 deviceId 存储）
  const dcKey = Object.keys(storage).find(k => k.startsWith('iCubeAuthInfo://icube-dc:'));
  const deviceId = dcKey ? dcKey.split(':').pop() : null;
  const deviceKeyPair = dcKey ? JSON.parse(await decrypt(storage[dcKey])) : null;

  // 3. machineId
  let machineId = '';
  try { machineId = fs.readFileSync(`${appData}\\TRAE SOLO CN\\machineid`, 'utf8').trim(); } catch (e) {}

  // 4. 组装服务器配置（设备指纹用本机真实值，保证一致性）
  const cfg = {
    exportedAt: new Date().toISOString(),
    auth: {
      token: auth.token,
      refreshToken: auth.refreshToken,
      expiredAt: auth.expiredAt,
      refreshExpiredAt: auth.refreshExpiredAt,
      host: auth.host,
      userId: auth.userId,
      userRegion: auth.userRegion,
    },
    device: {
      deviceId,
      machineId,
      clientVersion: '0.1.65',
      clientId: 'en1oxy7wnw8j9n', // SOLO 客户端 ClientID（源码 fallback，Pr()==true）
      platformCode: 'SOLO_PC',
      keyPair: deviceKeyPair,
      deviceInfoStatic: {
        DeviceType: 'PC',
        DeviceName: process.env.USERNAME || process.env.COMPUTERNAME || 'PC',
        OSInfo: 'windows',
      },
    },
  };

  if (!deviceKeyPair) { console.log('ERROR: 未找到设备密钥对'); return; }
  const out = process.argv[2] || 'trae_auth.json';
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`已导出: ${out}`);
  console.log(`- deviceId: ${deviceId}`);
  console.log(`- token 过期: ${auth.expiredAt}`);
  console.log(`- refreshToken 过期: ${auth.refreshExpiredAt}`);
  console.log(`- 密钥对: ${deviceKeyPair.privateKeyPEM ? 'OK' : '缺失'}`);
}
main().catch(e => console.log('Fatal:', e.message));