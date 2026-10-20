'use strict';
// Actual app bundles/renderers with isolated browser storage and intercepted cloud APIs.
// Every person, record and command response below is a test fixture, never production data.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const desktop=path.resolve(__dirname,'..'),mobile=path.resolve(desktop,'../EcoTrackAppMobileNew-master-control');
const out=path.join(desktop,'reports/panel-repairs/photo-browser');fs.mkdirSync(out,{recursive:true});
const mobileWeb=path.join(mobile,'artifacts/panel-repairs/build');
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const profile={id:'panel-staff',authUserId:userId,name:'Panel Test Technician',email:'panel@example.invalid',phone:'',role:'HVAC Technician',userType:'staff',assignment:'Demo Room'};
const authUser={id:userId,aud:'authenticated',role:'authenticated',email:profile.email,app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:'2026-10-01T00:00:00Z'};
const encode=data=>Buffer.from(JSON.stringify(data)).toString('base64url');
const token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:userId,aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})+'.fixture';
const session={access_token:token,refresh_token:'isolated-fixture',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:authUser};
const urlText=fs.readFileSync(path.join(mobile,'.env'),'utf8').match(/^EXPO_PUBLIC_SUPABASE_URL\s*=\s*["']?([^\s"']+)/m)?.[1];
const project=urlText?new URL(urlText).hostname.split('.')[0]:'ynopdmfhngooknybyahq';
function records(){return {
 staff:[{id:profile.id,auth_user_id:userId,name:profile.name,email:profile.email,room_id:'room-one',room_name:'Demo Room',assignment:'Demo Room',status:'offline'}],
 rooms:[{id:'room-one',name:'Demo Room',floor_id:'floor-one',node_limit:10}],floors:[{id:'floor-one',name:'Demo Floor',building_id:'building-one'}],buildings:[{id:'building-one',name:'Demo Building'}],
 nodes:[{id:'node-one',name:'Demo Controller',room_id:'room-one',aircon_type:'Split Type',temp:null,photo_url:JSON.stringify({addedByUserId:profile.id})}],
 aircons:[{id:'ac-one',asset_tag:'DEMO-AC',name:'Demo AC',controller_node_id:'node-one',node_id:'node-one',room_id:'room-one',brand:'TCL',aircon_type:'Split Type',protocol_name:'TCL112AC'}],
 ecotrack_device_state:[{node_id:'node-one',device_id:'esp32s3-111111111111',last_seen:new Date().toISOString(),capabilities:{cloud_protocol:1},latest_ir:null}],
 maintenance_reports:[{id:'MR-PHOTO',aircon_id:'ac-one',aircon_name:'Demo AC',room_id:'room-one',staff_id:profile.id,staff_name:profile.name,
 status:'In Progress',type:'Preventive Maintenance',tasks:[{id:'task-photo',name:'Inspect filter photo',status:'In Progress',photoUris:['storage://maintenance-photos/fixture/photo.png']}]}],mobile_notifications:[],rules:[],telemetry:[],notifications:[],ir_profiles:[],ir_captures:[],
};}
const mime=file=>({'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json','.ttf':'font/ttf'})[path.extname(file)]||'application/octet-stream';
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');const isMobile=!url.pathname.startsWith('/desktop');
 const root=isMobile?mobileWeb:path.join(desktop,'public');
 const rel=decodeURIComponent(url.pathname.replace(/^\/desktop\/?/,'').replace(/^\//,''));
 let file=path.resolve(root,rel||'index.html');
 if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(403);return res.end();}
 if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=isMobile?path.join(root,'index.html'):file;
 if(!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.setHeader('content-type',mime(file));res.end(fs.readFileSync(file));
});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const results=[];
 try{
  for(const app of ['mobile']){
   const context=await browser.newContext({viewport:app==='mobile'?{width:390,height:844}:{width:1460,height:1000},colorScheme:'dark',reducedMotion:'reduce'});
   await context.addInitScript(({session,project,profile})=>{
    localStorage.setItem('sb-'+project+'-auth-token',JSON.stringify(session));
    localStorage.setItem('ecoTrack_auth_token',session.access_token);localStorage.setItem('ecoTrack_refresh_token',session.refresh_token);
    localStorage.setItem('ecoTrack_profile_user',JSON.stringify(profile));localStorage.setItem('ecoTrackTheme','dark');
   },{session,project,profile});
   let stage='loaded',gateRelease;const cloudCalls=[];let signCalls=0, releasePhoto;
   const page=await context.newPage();const errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   if(page.routeWebSocket)await page.routeWebSocket('**/*',socket=>socket.close());
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.url().startsWith(base)){
     return route.continue();
    }
    if(!/^https?:/.test(request.url()))return route.continue();
    cloudCalls.push({path:url.pathname,method:request.method()});
    const json=(data,status=200,headers={})=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*',...headers},body:JSON.stringify(data)});
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}});
    if(request.method()==='POST' && url.pathname.startsWith('/storage/v1/object/sign/')){
     signCalls++; if(signCalls===1)await new Promise(resolve=>releasePhoto=resolve);
     return json({signedURL:'/object/sign/maintenance-photos/fixture/result-'+signCalls+'.png?token=fixture'});
    }
    if(url.pathname.includes('/storage/v1/object/sign/maintenance-photos/fixture/result-')){
     if(signCalls===1)return route.fulfill({status:404,body:''});
     return route.fulfill({status:200,contentType:'image/png',body:fs.readFileSync(path.join(mobile,'assets/images/ecoTrack.png'))});
    }
    if(url.pathname==='/auth/v1/user')return json(authUser);
    if(url.pathname==='/auth/v1/token')return json(session);
    if(url.pathname.includes('/rpc/ecotrack_my_profile'))return json(profile);
    if(url.pathname.includes('/rpc/ecotrack_list_notifications')){
     if(stage==='slow')await new Promise(resolve=>{gateRelease=(previous=>()=>{previous?.();resolve();})(gateRelease);});
     return json({items:[],next_cursor:null});
    }
    if(url.pathname.includes('/rpc/ecotrack_admin_list_staff'))return json(records().staff);
    if(url.pathname.startsWith('/rest/v1/')&&!url.pathname.includes('/rpc/')){
     if(stage==='slow')await new Promise(resolve=>{gateRelease=(previous=>()=>{previous?.();resolve();})(gateRelease);});
     if(stage==='failed')return json({message:'Fixture network failure',code:'fixture_failure'},503);
     const table=url.pathname.split('/').pop();let rows=stage==='empty'?[]:records()[table]||[];
     for(const [key,value]of url.searchParams){if(value.startsWith('eq.'))rows=rows.filter(row=>String(row[key])===value.slice(3));if(value.startsWith('gt.'))rows=rows.filter(row=>String(row[key])>value.slice(3));}
     const count=rows.length;const limit=Number(url.searchParams.get('limit')||250);rows=rows.slice(0,limit);
     if(request.headers().accept?.includes('application/vnd.pgrst.object'))return json(rows[0]||null);
     return json(rows,200,{'content-range':rows.length?'0-'+(rows.length-1)+'/'+count:'*/0'});
    }
    if(url.pathname==='/api/health')return json({status:'healthy',models_available:['random_forest']});
    if(url.pathname==='/api/telemetry')return json({items:[],totalItems:0,page:1,perPage:50,totalPages:0});
    if(/tailwind/.test(url.hostname))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(desktop,'scratch/step3-qa-tailwind.js'),'utf8')});
    // All unexpected remote calls, including real cloud/IR writes, are blocked.
    return json({message:'Blocked by isolated panel simulation'},403);
   });
   await page.goto(base+'/Maintenance?reportId=MR-PHOTO');
   await page.getByText('Inspect filter photo',{exact:true}).waitFor({timeout:15000});
   assert.equal(signCalls,0,'Closed photo editors must not request private image URLs');
   results.push({app,stage:'report renders without signing hidden photos',page_errors:[...errors]});
   await page.getByText('Inspect filter photo',{exact:true}).click();
   await page.getByLabel('Loading photo').waitFor({timeout:15000});
   await page.waitForFunction(()=>document.querySelector('[aria-label="Loading photo"]'));
   await page.screenshot({path:path.join(out,'photo-loading.png')});
   assert.equal(signCalls,1);releasePhoto();
   await page.getByRole('button',{name:'Retry loading photo'}).waitFor({timeout:15000});
   await page.screenshot({path:path.join(out,'photo-error.png')});
   results.push({app,stage:'failed photo shows retry without blocking the editable report',page_errors:[...errors]});
   await page.getByRole('button',{name:'Retry loading photo'}).click();
   await page.waitForFunction(()=>[...document.images].some(image=>image.src.includes('result-2.png')&&image.complete&&image.naturalWidth>0));
   await page.waitForTimeout(600);
   assert.equal(signCalls,2,'Retry must renew the signature');
   assert.equal(await page.getByRole('button',{name:'Retry loading photo'}).count(),0);
   await page.screenshot({path:path.join(out,'photo-recovered.png')});
   assert.deepEqual(errors,[]);
   results.push({app,stage:'retry signs again and displays the photo',page_errors:[...errors]});
   await context.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
 console.log(JSON.stringify({checks:results.length,page_errors:results.filter(row=>row.page_errors.length),output:out},null,2));
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
