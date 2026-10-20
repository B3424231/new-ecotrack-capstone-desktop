const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('public/js/node-sync.js','utf8');
const block=source.slice(source.indexOf('  const _commandReceiptChecks'),source.indexOf('  function startBackgroundTelemetryCadence('));
let profile={device_id:'AC-1',aircon_id:'ac-db',node_id:'hardware-id',control_snapshot:{command_id:'command-1',command_status:'queued'}}, error=null, result=null, writes=0, changedDuringRead=false;
const node={id:'node-db',name:'hardware-id'};
const receipt=()=>({id:profile.control_snapshot.command_id,node_id:'node-db',kind:'ac_intent',payload:{aircon_id:'ac-db'},status:'completed',result:{command_id:profile.control_snapshot.command_id,success:true,delivery_status:'transmitted'}});
const sb={rpc:()=>{throw new Error('Browser cannot write a hardware acknowledgement');},from(table){assert.equal(table,'ecotrack_device_commands');const q={select(){return q;},eq(){return q;},async maybeSingle(){const value=result;if(changedDuringRead)profile.control_snapshot={command_id:'new-command',command_status:'queued'};return {data:value,error};}};return q;}};
const context=vm.createContext({console,Date,window:{EcoTrackHardwareCloud:{},EcoTrackAirconSystem:{AirconProfileManager:{getAll:()=>[profile],updateState:(_id,_update,snapshot)=>profile.control_snapshot=snapshot}}},getSupabase:()=>sb,getAssignedNodesWithSchedule:async()=>[node],saveNodeTelemetryToSqlite:async()=>{writes++;},fetch:()=>{throw new Error('No LAN requests allowed');}});
vm.runInContext(block,context);
async function main(){
 const checks=[];result=receipt();await context.reconcilePendingCommandReceipt(node,10000);assert.equal(profile.control_snapshot.command_status,'transmitted');checks.push('Matching cloud transmission receipt updates status without LAN or browser acknowledgement writes');
 profile.control_snapshot={command_id:'command-2',command_status:'queued'};result={...receipt(),node_id:'other-node'};await context.reconcilePendingCommandReceipt(node,20000);assert.equal(profile.control_snapshot.command_status,'queued');checks.push('Receipt for another controller is ignored');
 profile.control_snapshot={command_id:'command-3',command_status:'queued'};result=receipt();error={message:'Access denied'};await context.reconcilePendingCommandReceipt(node,30000);assert.equal(profile.control_snapshot.command_status,'queued');error=null;checks.push('Failed cloud read preserves queued status');
 profile.control_snapshot={command_id:'command-4',command_status:'queued'};result={...receipt(),status:'expired'};await context.reconcilePendingCommandReceipt(node,40000);assert.equal(profile.control_snapshot.command_status,'failed');checks.push('Expired command is failed rather than transmitted');
 profile.control_snapshot={command_id:'command-5',command_status:'queued'};result=receipt();changedDuringRead=true;await context.reconcilePendingCommandReceipt(node,50000);assert.equal(profile.control_snapshot.command_id,'new-command');assert.equal(profile.control_snapshot.command_status,'queued');changedDuringRead=false;checks.push('Old receipt cannot overwrite a newer request');
 result=receipt();await context.stepBackgroundTelemetryCadence();await Promise.resolve();assert.equal(writes,0);checks.push('Cloud mode does not create sensor history from browser timers or cached nodes');
 fs.writeFileSync('reports/cloud-hardware/sync-tests.json',JSON.stringify({checks,passed:checks.length},null,2));console.log(`Cloud receipt/history sync: ${checks.length} checks passed.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
