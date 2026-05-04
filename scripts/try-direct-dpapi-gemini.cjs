// Last-resort: maybe THIS specific .bin was written by raw DPAPI (no v10
// AES envelope), and the "v10" prefix is just a coincidence of the
// random nonce. Try DPAPI unprotect on the whole file, on bytes after
// the prefix, on full payload, etc.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROAMING = path.join(process.env.APPDATA, 'jikkyou-cut');

function dpapiUnprotect(bytes, label) {
  const b64In = bytes.toString('base64');
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
try {
  $enc = [Convert]::FromBase64String('${b64In}')
  $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  Write-Output "OK"
  Write-Output ([Convert]::ToBase64String($dec))
} catch {
  Write-Output "FAIL"
  Write-Output $_.Exception.Message
}
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const lines = r.stdout.trim().split(/\r?\n/);
  if (lines[0] === 'OK') {
    const dec = Buffer.from(lines[1], 'base64');
    console.log(`[${label}] ✓ DPAPI OK (${dec.length} bytes)`);
    console.log(`[${label}] preview: ${dec.toString('utf8').slice(0, 200)}`);
    return dec;
  } else {
    console.log(`[${label}] ✗ DPAPI: ${lines[1]}`);
    return null;
  }
}

const fp = path.join(ROAMING, 'geminiApiKeys.bin');
const buf = fs.readFileSync(fp);
console.log('size:', buf.length);

dpapiUnprotect(buf, 'whole-file');
dpapiUnprotect(buf.slice(3), 'after-v10-prefix');
dpapiUnprotect(buf.slice(0, buf.length), 'whole-again');
