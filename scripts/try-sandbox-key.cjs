const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROAMING = path.join(process.env.APPDATA, 'jikkyou-cut');
const SANDBOX = path.join(
  process.env.LOCALAPPDATA,
  'Packages',
  'Claude_pzs8sxrjxfjjc',
  'LocalCache',
  'Roaming',
  'jikkyou-cut',
);

function dpapiUnprotect(encryptedBytes) {
  const b64In = encryptedBytes.toString('base64');
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String('${b64In}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($dec)
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`DPAPI unprotect failed: ${r.stderr || r.stdout}`);
  return Buffer.from(r.stdout.trim(), 'base64');
}

function loadMasterKey(localStatePath) {
  const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const enc = Buffer.from(ls.os_crypt.encrypted_key, 'base64').slice(5);
  return dpapiUnprotect(enc);
}

function tryDecrypt(filePath, masterKey, label) {
  const buf = fs.readFileSync(filePath);
  if (buf.slice(0, 3).toString('utf8') !== 'v10') {
    console.log(`[${label}] not v10`);
    return false;
  }
  const nonce = buf.slice(3, 15);
  const tag = buf.slice(buf.length - 16);
  const ct = buf.slice(15, buf.length - 16);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    console.log(`[${label}] ✓ DECRYPTED (${plain.length} chars)`);
    console.log(`[${label}] preview: ${plain.slice(0, 200)}`);
    return plain;
  } catch (e) {
    console.log(`[${label}] ✗ ${e.message}`);
    return false;
  }
}

const roamingLS = path.join(ROAMING, 'Local State');
const sandboxLS = path.join(SANDBOX, 'Local State');

const roamingBytes = fs.readFileSync(roamingLS);
const sandboxBytes = fs.readFileSync(sandboxLS);
console.log('roaming Local State bytes:', roamingBytes.length);
console.log('sandbox Local State bytes:', sandboxBytes.length);
console.log('same content?', roamingBytes.equals(sandboxBytes));

const roamingKey = loadMasterKey(roamingLS);
const sandboxKey = loadMasterKey(sandboxLS);
console.log('roaming key (hex):', roamingKey.toString('hex'));
console.log('sandbox key (hex):', sandboxKey.toString('hex'));
console.log('keys equal?', roamingKey.equals(sandboxKey));

const gem = path.join(ROAMING, 'geminiApiKeys.bin');
console.log('\n--- gemini with roaming key ---');
tryDecrypt(gem, roamingKey, 'gem+roam');
console.log('\n--- gemini with sandbox key ---');
tryDecrypt(gem, sandboxKey, 'gem+sand');
