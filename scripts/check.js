import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const files = [];
function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const name = path.join(dir, entry.name); if (entry.isDirectory()) walk(name); else if (name.endsWith('.js')) files.push(name); } }
for (const dir of ['src', 'public', 'scripts', 'tests']) walk(dir);
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }); if (result.status) process.exit(result.status); }
console.log(`Sintaxe verificada em ${files.length} arquivos JavaScript.`);
