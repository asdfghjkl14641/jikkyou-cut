// GCM = CTR + GMAC. If only the auth tag is wrong (truncation, single-bit
// flip, replaced tag), the plaintext is recoverable by decrypting in
// CTR mode with the right initial counter. For 12-byte GCM nonces:
//   J0 = nonce || 0x00000001
//   first plaintext block uses counter = J0 + 1 = nonce || 0x00000002
// We'll try BOTH starting counters in case the bin layout differs.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const APPDATA = process.env.APPDATA;
const ROOT = path.join(APPDATA, 'jikkyou-cut');

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

function getMasterKey() {
  const ls = JSON.parse(fs.readFileSync(path.join(ROOT, 'Local State'), 'utf8'));
  const enc = Buffer.from(ls.os_crypt.encrypted_key, 'base64').slice(5);
  return dpapiUnprotect(enc);
}

function decryptCtr(ciphertext, key, counterInitial) {
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, counterInitial);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function makeCounter(nonce, intValue) {
  // 12-byte nonce + 4-byte big-endian counter = 16-byte counter block
  const counter = Buffer.alloc(16);
  nonce.copy(counter, 0);
  counter.writeUInt32BE(intValue, 12);
  return counter;
}

function main() {
  const masterKey = getMasterKey();
  console.log('master key bytes:', masterKey.length);

  const fp = path.join(ROOT, 'geminiApiKeys.bin');
  const buf = fs.readFileSync(fp);
  console.log('file size:', buf.length);

  if (buf.slice(0, 3).toString('utf8') !== 'v10') {
    throw new Error('not v10');
  }
  const nonce = buf.slice(3, 15);
  // GCM appends 16-byte tag. Try BOTH layouts:
  //   A) v10 || nonce || ciphertext || tag(16)  ← Chromium's actual layout
  //   B) v10 || nonce || ciphertext             ← no tag (plain CTR)
  const ctWithTag = buf.slice(15);
  const ctWithoutTag = buf.slice(15, buf.length - 16);

  // Try J0+1 counter (=2) first (GCM standard for first plaintext block)
  for (const startCounter of [1, 2]) {
    for (const layout of [
      { name: 'no-tag', ct: ctWithoutTag },
      { name: 'with-tag-as-data', ct: ctWithTag },
    ]) {
      try {
        const ctr = makeCounter(nonce, startCounter);
        const plain = decryptCtr(layout.ct, masterKey, ctr);
        const text = plain.toString('utf8');
        const printable = text.replace(/[^\x20-\x7e\n\r\t]/g, '?');
        const printableRatio = (text.match(/[\x20-\x7e\n\r\t]/g) || []).length / text.length;
        console.log(`\n--- counter=${startCounter}, layout=${layout.name} ---`);
        console.log(`printable ratio: ${(printableRatio * 100).toFixed(1)}%`);
        console.log(`first 200 chars: ${printable.slice(0, 200)}`);
        if (printableRatio > 0.9) {
          const out = path.join(__dirname, `recovered-gemini-c${startCounter}-${layout.name}.txt`);
          fs.writeFileSync(out, text, 'utf8');
          console.log(`saved to ${out}`);
        }
      } catch (e) {
        console.log(`counter=${startCounter} layout=${layout.name}: ${e.message}`);
      }
    }
  }
}

main();
