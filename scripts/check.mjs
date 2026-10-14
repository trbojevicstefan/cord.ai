import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
async function check(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()){if(entry.name!=='vendor')await check(path);}else if(/\.(mjs|cjs|js)$/.test(path)){const result=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}}}
for(const dir of ['server','public','bridge','scripts','tests'])await check(dir);
console.log('All application, bridge and test sources parse successfully.');
