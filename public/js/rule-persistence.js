(function(root){
  'use strict';
  function identities(values){
    if(!Array.isArray(values)||values.some(id=>typeof id!=='string'||!id.trim()))throw Error('Invalid rule device identities.');
    return [...new Set(values)].sort();
  }
  function assertSave(data,id,targets){
    if(!data||typeof data.rule_id!=='string'||!data.rule_id||(id&&data.rule_id!==id)||!Array.isArray(data.target_nodes)||
       JSON.stringify([...data.target_nodes].sort())!==JSON.stringify(identities(targets)))throw Error('The server did not confirm the rule and every selected device.');
    return data;
  }
  function assertToggle(data,ids,enabled){
    const expected=identities(ids);
    if(!Array.isArray(data)||data.length!==expected.length||data.some(row=>row?.enabled!==enabled)||
       JSON.stringify(data.map(row=>row.id).sort())!==JSON.stringify(expected))throw Error('The server did not confirm every rule status change.');
    return data;
  }
  async function call(client,name,args){
    if(!client?.rpc)throw Error('Reconnect to the database before saving rules.');
    const {data,error}=await client.rpc(name,args);
    if(error)throw Object.assign(new Error(error.code==='PGRST202'?'Apply the atomic_rule_workflows database migration, then retry.':error.message||'Rule changes could not be saved.'),{code:error.code});
    return data;
  }
  async function save(client,rule,targets,id=null){
    const ids=identities(targets),data=await call(client,'ecotrack_save_rule',{p_rule:rule,p_target_nodes:ids,p_rule_id:id});
    return assertSave(data,id,ids);
  }
  async function setEnabled(client,ids,enabled){
    const expected=identities(ids);if(!expected.length||typeof enabled!=='boolean')throw Error('Choose valid rules and a status.');
    return assertToggle(await call(client,'ecotrack_set_rules_enabled',{p_rule_ids:expected,p_enabled:enabled}),expected,enabled);
  }
  const api=Object.freeze({save,setEnabled,assertSave,assertToggle});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.EcoTrackRulePersistence=api;
})(typeof window==='undefined'?globalThis:window);
