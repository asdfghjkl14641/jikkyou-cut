// Decrypt the current .bin and compare its content set with the
// plaintext backup. Reports diffs without printing key values.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

function dpapi(b) {
  const b64 = b.toString('base64');
  const ps = `Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String('${b64}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($dec)`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return Buffer.from(r.stdout.trim(), 'base64');
}

const root = path.join(os.homedir(), 'AppData', 'Roaming', 'jikkyou-cut');
const ls = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
const masterKey = dpapi(Buffer.from(ls.os_crypt.encrypted_key, 'base64').slice(5));

function decryptBin(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 3).toString('utf8') !== 'v10') throw new Error('not v10');
  const nonce = buf.slice(3, 15);
  const tag = buf.slice(buf.length - 16);
  const ct = buf.slice(15, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const backupPath = path.join(os.homedir(), 'Documents', 'jikkyou-cut-backup', 'api-keys.json');
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

for (const slot of ['gemini', 'youtube']) {
  const binFile = path.join(root, slot === 'gemini' ? 'geminiApiKeys.bin' : 'youtubeApiKeys.bin');
  const backupSet = new Set(backup.keys[slot] || []);
  let binSet = new Set();
  if (fs.existsSync(binFile)) {
    try {
      const arr = JSON.parse(decryptBin(binFile));
      binSet = new Set(arr);
    } catch (e) {
      console.log(`[${slot}] .bin decrypt failed: ${e.message}`);
    }
  } else {
    console.log(`[${slot}] .bin missing`);
  }

  const onlyBin = [...binSet].filter((k) => !backupSet.has(k));
  const onlyBackup = [...backupSet].filter((k) => !binSet.has(k));
  const both = [...binSet].filter((k) => backupSet.has(k));

  console.log(`\n=== ${slot} ===`);
  console.log(`  .bin    : ${binSet.size} 個`);
  console.log(`  backup  : ${backupSet.size} 個`);
  console.log(`  共通    : ${both.length} 個`);
  console.log(`  .bin のみ: ${onlyBin.length} 個`);
  console.log(`  backup のみ: ${onlyBackup.length} 個`);
  if (onlyBin.length > 0) {
    console.log(`  .bin only suffixes:`, onlyBin.slice(0, 5).map((k) => '...' + k.slice(-4)).join(' '));
  }
  if (onlyBackup.length > 0) {
    console.log(`  backup only suffixes:`, onlyBackup.slice(0, 5).map((k) => '...' + k.slice(-4)).join(' '));
  }
}
