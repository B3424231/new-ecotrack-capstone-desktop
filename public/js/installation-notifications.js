(function(root) {
  'use strict';
  const TYPE = 'controller_installation';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const isInstallation = record => record?.type === TYPE;
  function installationTime(value) {
    const date = new Date(value || '');
    if (!Number.isFinite(date.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone:'Asia/Singapore', year:'numeric',month:'2-digit',day:'2-digit'
    }).formatToParts(date).map(part => [part.type,part.value]));
    return {date:`${parts.year}-${parts.month}-${parts.day}`,time:new Intl.DateTimeFormat('en-US', {
      timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true
    }).format(date)};
  }
  function toMessage(record, readState = {}) {
    const saved = record?.installation;
    // Never infer an installation's destination from names, message text or current hardware location.
    if (!isInstallation(record) || !saved || typeof saved !== 'object' ||
      !saved.room_id || !saved.node_id || !saved.controller_name ||
      (record.room_id && record.room_id !== saved.room_id)) return null;
    const stamp = installationTime(saved.installed_at);
    if (!stamp) return null;
    const title = saved.event_kind === 'reinstallation' ? 'ESP32 Reinstalled' : 'ESP32 Installed';
    const actor = saved.installer_name || 'Installer name unavailable';
    const location = [saved.building_name,saved.floor_name,saved.room_name].filter(Boolean).join(' → ');
    return {id:record.id,pbId:record.id,type:TYPE,room_id:saved.room_id,room:saved.room_id,node:saved.node_id,
      nodes:[saved.controller_name],installation:saved,date:stamp.date,time:stamp.time,
      content:`${title}: ${actor} installed “${saved.controller_name}” at ${location}.`,
      triggered:record.triggered ?? true,read:Boolean(readState[String(record.id)])};
  }
  function renderDetails(saved) {
    const stamp = installationTime(saved.installed_at);
    const title = saved.event_kind === 'reinstallation' ? 'ESP32 Reinstalled' : 'ESP32 Installed';
    const fields = [
      ['Installed by',saved.installer_name || 'Unavailable'],
      ['Account role',[saved.installer_account_role,saved.installer_role].filter(Boolean).join(' · ')],
      ['Controller',saved.controller_name],['ESP32 hardware ID',saved.device_id],
      ['Location',[saved.building_name,saved.floor_name,saved.room_name].filter(Boolean).join(' → ')],
      ['Installed at',stamp ? `${stamp.date} at ${stamp.time} SGT` : 'Unavailable'],
      ['Linked AC',saved.aircon_name || saved.aircon_id || 'Unavailable'],['AC type',saved.aircon_type || 'Unavailable']
    ];
    return `<div role="region" aria-label="Installation details" tabindex="0" class="bg-gray-50/90 dark:bg-[#070d1e] rounded-2xl p-6 border border-gray-200 dark:border-white/10 shadow-sm max-h-[60vh] overflow-y-auto eco-slim-scrollbar">
      <span class="inline-flex px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300">Installation</span>
      <h3 class="text-lg font-bold text-[#18392B] dark:text-white mt-3 mb-5">${title}</h3>
      <dl class="grid gap-4">${fields.map(([label,value]) => `<div><dt class="text-xs font-bold text-gray-500 dark:text-gray-400">${label}</dt><dd class="text-sm font-semibold text-gray-800 dark:text-gray-100 mt-1 break-words">${escapeHtml(value)}</dd></div>`).join('')}</dl>
      <p class="mt-5 text-xs text-gray-500 dark:text-gray-400">Saved when verified registration completed. Location and names reflect this installation.</p>
    </div>`;
  }
  const api={TYPE,isInstallation,toMessage,renderDetails,escapeHtml,installationTime};
  if (typeof module==='object' && module.exports) module.exports=api;
  else root.EcoTrackInstallations=api;
})(typeof globalThis==='object'?globalThis:this);
