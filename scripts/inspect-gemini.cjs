const fs = require('node:fs');
const path = require('node:path');

const fp = path.join(process.env.APPDATA, 'jikkyou-cut', 'geminiApiKeys.bin');
const buf = fs.readFileSync(fp);
console.log('size:', buf.length);
console.log('first 32 bytes (hex):', buf.slice(0, 32).toString('hex'));
console.log('first 8 bytes as utf8:', JSON.stringify(buf.slice(0, 8).toString('utf8')));
console.log('last 32 bytes (hex):', buf.slice(buf.length - 32).toString('hex'));
