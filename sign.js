// sign.js
const crypto = require('crypto');

if (process.argv.length < 4) {
  console.log('Usage: node sign.js <json-body> <secret>');
  process.exit(1);
}

const body = process.argv[2];
const secret = process.argv[3];

const h = crypto.createHmac('sha256', secret)
  .update(Buffer.from(body, 'utf8'))
  .digest('hex');

console.log(h);