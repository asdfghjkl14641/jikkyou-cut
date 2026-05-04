// Try varying offsets / lengths for the nonce in case the Gemini bin
// has an unusual layout. Also try: no v10 prefix, nonce at start.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROAMING = path.join(process.env.APPDATA, 'jikkyou-cut');

function dpapiUnprotect(bytes) {
  const b64 = bytes.toString('base64');
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String('${b64}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($dec)
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return Buffer.from(r.stdout.trim(), 'base64');
}

const ls = JSON.parse(fs.readFileSync(path.join(ROAMING, 'Local State'), 'utf8'));
const masterKey = dpapiUnprotect(Buffer.from(ls.os_crypt.encrypted_key, 'base64').slice(5));

const buf = fs.readFileSync(path.join(ROAMING, 'geminiApiKeys.bin'));
console.log('size:', buf.length);

// Try a few candidate layouts:
const tries = [
  { name: 'standard v10', prefixLen: 3, nonceLen: 12, tagLen: 16 },
  { name: 'no prefix, 12n+tag', prefixLen: 0, nonceLen: 12, tagLen: 16 },
  { name: 'no prefix, no tag', prefixLen: 0, nonceLen: 12, tagLen: 0 },
  { name: 'no prefix, 16n+tag', prefixLen: 0, nonceLen: 16, tagLen: 16 },
  { name: 'v10 prefix, 16n+tag', prefixLen: 3, nonceLen: 16, tagLen: 16 },
  { name: 'no prefix, gcm 12n no tag', prefixLen: 0, nonceLen: 12, tagLen: 0, mode: 'ctr' },
];

for (const t of tries) {
  const nonce = buf.slice(t.prefixLen, t.prefixLen + t.nonceLen);
  if (t.mode === 'ctr') {
    // CTR mode using nonce as IV (with counter at end)
    const iv = Buffer.alloc(16);
    nonce.copy(iv, 0);
    iv.writeUInt32BE(2, 12);
    const ct = buf.slice(t.prefixLen + t.nonceLen);
    try {
      const d = crypto.createDecipheriv('aes-256-ctr', masterKey, iv);
      const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      const ratio = (plain.match(/[\x20-\x7e\n\r\t]/g) || []).length / plain.length;
      console.log(`[${t.name}] CTR ratio=${(ratio * 100).toFixed(1)}% first50: ${JSON.stringify(plain.slice(0, 50))}`);
    } catch (e) {
      console.log(`[${t.name}] CTR err: ${e.message}`);
    }
    continue;
  }
  if (t.nonceLen !== 12 && t.nonceLen !== 16) continue;
  try {
    const tagStart = buf.length - t.tagLen;
    const ct = buf.slice(t.prefixLen + t.nonceLen, t.tagLen ? tagStart : undefined);
    const tag = t.tagLen ? buf.slice(tagStart) : null;
    const algo = t.nonceLen === 12 ? 'aes-256-gcm' : 'aes-256-gcm';
    const d = crypto.createDecipheriv(algo, masterKey, nonce, t.nonceLen === 16 ? { authTagLength: 16 } : undefined);
    if (tag) d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    console.log(`[${t.name}] ✓ DECRYPTED ${plain.slice(0, 100)}`);
  } catch (e) {
    console.log(`[${t.name}] ✗ ${e.message}`);
  }
}
