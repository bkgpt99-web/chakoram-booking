import {readdir,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
for(const dir of ['public','server','netlify/functions'])for(const name of await readdir(dir)){
 if(/\.(mjs|js)$/.test(name))execFileSync(process.execPath,['--check',resolve(dir,name)],{stdio:'inherit'});
}
for(const name of ['public/index.html','public/admin.html','database/setup.sql','netlify.toml'])await access(name);
console.log('Booking engine validated. Public assets: public/; server functions: netlify/functions/.');
