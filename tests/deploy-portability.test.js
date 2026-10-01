import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const root=path.join(__dirname,"..");
const docker=fs.readFileSync(path.join(root,"Dockerfile"),"utf8");
const env=fs.readFileSync(path.join(root,".env.northflank.example"),"utf8");
const guide=fs.readFileSync(path.join(root,"docs","NORTHFLANK_FREE.md"),"utf8");
const keep=fs.readFileSync(path.join(root,".github","workflows","keep-warm.yml"),"utf8");
const monitor=fs.readFileSync(path.join(root,".github","workflows","process-monitor.yml"),"utf8");
const server=fs.readFileSync(path.join(root,"src","server.js"),"utf8");

assert.match(docker,/FROM node:22-/);
assert.match(docker,/EXPOSE 10000/);
assert.match(docker,/HEALTHCHECK/);
assert.match(docker,/\/api\/health/);
assert.match(docker,/CMD \["npm","start"\]/);

for(const key of [
  "SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","WA_DB_SECRET",
  "WA_MEMORY_LIMIT_MB","WA_MEMORY_PAUSE_MB","WA_MEMORY_RESUME_MB"
]) assert.match(env,new RegExp("^"+key+"=","m"),"env Northflank sem "+key);

assert.match(server,/process\.env\.PORT \|\| 10000/);
assert.match(server,/listen\(port, '0\.0\.0\.0'/);

assert.match(keep,/WA_AUTO_BASE_URL/);
assert.match(monitor,/WA_AUTO_BASE_URL/);
assert.match(keep,/service has been suspended\|suspended by its owner/);
assert.match(monitor,/service has been suspended\|suspended by its owner/);

assert.match(guide,/Northflank/);
assert.match(guide,/health check: `\/api\/health`/i);
assert.match(guide,/WA_AUTO_URL/);

console.log("deploy-portability: ok");
