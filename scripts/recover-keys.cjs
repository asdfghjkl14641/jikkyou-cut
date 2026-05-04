// Emergency recovery for safeStorage-encrypted .bin files.
//
// Electron safeStorage on Windows uses Chromium OSCrypt v10 envelope:
//   payload = "v10" || nonce(12) || ciphertext || tag(16)
// AES-256-GCM with a 32-byte master key. The master key is stored
// (DPAPI-encrypted, base64'd, "DPAPI" magic prefix) in Local State JSON
// at os_crypt.encrypted_key. So:
//   1) base64-decode encrypted_key, strip 5-byte "DPAPI" prefix
//   2) DPAPI-decrypt → 32-byte AES master key
//   3) For each .bin: strip "v10" prefix → nonce + ciphertext+tag,
//      decrypt with AES-256-GCM and master key.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const APPDATA = process.env.APPDATA;
const ROOT = path.join(APPDATA, 'jikkyou-cut');
const LOCAL_STATE = path.join(ROOT, 'Local State');

function dpapiUnprotect(encryptedBytes) {
  // Spawn PowerShell to call ProtectedData.Unprotect (CurrentUser scope).
  // We pass bytes as base64 on the command line and read decrypted bytes
  // back as base64 from stdout to avoid binary-pipe corruption.
  const b64In = encryptedBytes.toString('base64');
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String('${b64In}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($dec)
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`DPAPI unprotect failed: ${r.stderr || r.stdout}`);
  }
  return Buffer.from(r.stdout.trim(), 'base64');
}

function decryptBin(filePath, masterKey) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 3 + 12 + 16) {
    throw new Error(`too short: ${buf.length} bytes`);
  }
  const prefix = buf.slice(0, 3).toString('utf8');
  if (prefix !== 'v10') {
    throw new Error(`expected v10 prefix, got "${prefix}"`);
  }
  const nonce = buf.slice(3, 15);
  const tag = buf.slice(buf.length - 16);
  const ciphertext = buf.slice(15, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

function main() {
  console.log('reading Local State from:', LOCAL_STATE);
  const localState = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
  const encKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encKeyB64) throw new Error('Local State missing os_crypt.encrypted_key');

  const encKey = Buffer.from(encKeyB64, 'base64');
  const magic = encKey.slice(0, 5).toString('utf8');
  if (magic !== 'DPAPI') {
    throw new Error(`expected DPAPI magic, got "${magic}"`);
  }
  const dpapiBlob = encKey.slice(5);
  console.log('DPAPI blob bytes:', dpapiBlob.length);

  const masterKey = dpapiUnprotect(dpapiBlob);
  console.log('master key bytes:', masterKey.length, '(expected 32)');
  if (masterKey.length !== 32) {
    throw new Error(`unexpected master key size: ${masterKey.length}`);
  }

  const targets = [
    'geminiApiKeys.bin',
    'youtubeApiKeys.bin',
    'apiKey.bin',
    'anthropicKey.bin',
    'twitchClientSecret.bin',
  ];

  const out = {};
  for (const name of targets) {
    const fp = path.join(ROOT, name);
    if (!fs.existsSync(fp)) {
      console.log(`[${name}] not found, skipping`);
      continue;
    }
    try {
      const plain = decryptBin(fp, masterKey);
      out[name] = plain;
      console.log(`[${name}] OK (${plain.length} chars)`);
    } catch (err) {
      console.log(`[${name}] FAILED: ${err.message}`);
    }
  }

  const dest = path.join(__dirname, 'recovered-keys.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  console.log('\nrecovered keys written to:', dest);
}

main();
