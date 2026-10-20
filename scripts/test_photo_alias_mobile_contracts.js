'use strict';
// Run the existing mobile PostgreSQL contract suite with the new desktop
// migration inserted into its disposable fixture. Mobile sources stay untouched.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const root=path.resolve(__dirname,'..'),mobile=path.resolve(root,'../EcoTrackAppMobileNew-master-control');
const file=path.join(mobile,'scripts/test-database-contracts.cjs');
let source=fs.readFileSync(file,'utf8');
const anchor="  await owner('update public.staff set auth_user_id";
if(source.split(anchor).length!==2)throw Error('Existing contract fixture entry point changed; inspect before running');
const setup=`  await db.exec('alter table public.nodes add column if not exists photo_url text;alter table public.nodes add column if not exists image_url text;');
  await db.exec(fs.readFileSync(${JSON.stringify(path.join(root,'scripts/fixtures/photo-alias-profile-functions.sql'))},'utf8'));
  await db.exec(fs.readFileSync(${JSON.stringify(path.join(root,'supabase/migrations/20261019182804_consolidate_unused_photo_aliases.sql'))},'utf8'));
`;
source=source.replace(anchor,setup+anchor);
process.chdir(mobile);
const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));compiled._compile(source,file);
