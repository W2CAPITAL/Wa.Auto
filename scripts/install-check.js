import fs from 'node:fs';
import { createHash } from 'node:crypto';
const hash = createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex');
const file = 'node_modules/.wa-auto-install';
if (process.argv.includes('--save')) fs.writeFileSync(file, hash);
else {
  try { process.exit(fs.existsSync('node_modules/whatsapp-web.js/package.json') && fs.readFileSync(file, 'utf8') === hash ? 0 : 1); }
  catch { process.exit(1); }
}
