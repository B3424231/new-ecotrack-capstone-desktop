(function(root){
  'use strict';
  function battery(node){
    const candidates=[node?.cloud_state?.battery_percent,node?.cloud_state?.capabilities?.battery_percent,node?.battery_percent,
      node?.battery_unit==='percent'||node?.battery_unit==='%'?node?.battery:null];
    const value=candidates.find(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100);
    return {percent:value??0,reported:value!==undefined};
  }
  function timestamp(value){
    if(typeof value!=='string'||!value.trim())return null;
    const parsed=new Date(value);if(!Number.isFinite(parsed.getTime()))return null;
    return {iso:parsed.toISOString(),date:parsed.toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}),
      time:parsed.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
      zone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  }
  function render(node){
    const reading=battery(node),batteryEl=document.getElementById('viewBattery');
    batteryEl.textContent=reading.percent+'%';
    batteryEl.title=reading.reported?'Battery percentage reported by this controller':'No battery reading reported by this controller';
    batteryEl.dataset.reported=String(reading.reported);
    const saved=timestamp(node.deployment_saved_at||node.admin_verified_at),verified=timestamp(node.admin_verified_at);
    for(const [id,text] of [['viewDeploymentDate',saved?.date],['viewDeploymentTime',saved?.time]]){
      const el=document.getElementById(id);el.textContent=text||'Not recorded';
      if(saved)el.setAttribute('datetime',saved.iso);else el.removeAttribute('datetime');
    }
    document.getElementById('viewDeploymentTimezone').textContent=saved?saved.zone:'Save & Verify records the admin timestamp.';
    const label=document.getElementById('viewAdminVerified');
    label.textContent=verified?'Admin verified: '+verified.date+' at '+verified.time:'Admin verification date not recorded';
    label.title=verified?.zone||'Older records do not contain a verification timestamp.';
  }
  root.EcoTrackControllerDetails={battery,timestamp,render};
})(window);
