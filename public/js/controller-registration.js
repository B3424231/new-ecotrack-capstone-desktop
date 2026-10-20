(function(root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const text = id => ($(id)?.value || '').trim();
  const safeText = value => value.length > 0 && value.length <= 100 && !/[\x00-\x1f<>]/.test(value);
  let brands = [], index = -1, onChange = () => {};
  function mode() { return document.querySelector('input[name="registrationAssignment"]:checked')?.value || ''; }
  function type() { return text('nodeFormAirconType') === '__custom__' ? text('registrationCustomType') : text('nodeFormAirconType'); }
  function fields() {
    const deviceMode = text('nodeFormDeviceMode');
    return {device_mode:deviceMode,sensor_config:['monitoring','both'].includes(deviceMode) ? {pressure_sensor:text('registrationPressureSensor'),pressure_min_pa:text('registrationPressureMin') === '' ? null : Number(text('registrationPressureMin')),pressure_max_pa:text('registrationPressureMax') === '' ? null : Number(text('registrationPressureMax'))} : null,
      controller_name:text('nodeFormName'),assignment_mode:mode(),aircon_id:text('nodeFormAircon') || null,
      asset_tag:text('registrationAcName'),aircon_name:mode()==='new'?text('registrationAcName'):$('registrationCustomNameWrap')?.hidden===false?text('registrationCustomName'):null,brand:text('nodeFormBrand'),aircon_type:type()};
  }
  function validate(needsPassword = false) {
    const data = fields(), errors = {};
    if (!['monitoring','controller','both'].includes(data.device_mode)) errors.nodeFormDeviceMode='Choose an AC device type.';
    if (data.sensor_config && (!safeText(data.sensor_config.pressure_sensor) || !Number.isFinite(data.sensor_config.pressure_min_pa) || !Number.isFinite(data.sensor_config.pressure_max_pa) || data.sensor_config.pressure_min_pa < -100000 || data.sensor_config.pressure_max_pa > 100000 || data.sensor_config.pressure_min_pa >= data.sensor_config.pressure_max_pa)) errors.registrationSensorConfig='Enter the pressure sensor model and a valid measurement range.';
    if (!safeText(data.controller_name)) errors.nodeFormName = 'Enter an AC device name (1–100 characters).';
    if (!['existing','new'].includes(data.assignment_mode)) errors.registrationAssignment = 'Choose an existing AC or create a new one.';
    else if (data.assignment_mode === 'existing' && (!data.aircon_id || !Array.from($('nodeFormAircon').options).some(o => o.value === data.aircon_id)))
      errors.nodeFormAircon = 'Select an available air conditioner.';
    else if (data.assignment_mode === 'new' && (!safeText(data.asset_tag) || data.asset_tag.length > 64))
      errors.registrationAcName = 'Enter an AC profile name (1–64 characters).';
    if (data.aircon_name!==null && (!safeText(data.aircon_name) || data.aircon_name.length>100)) errors.registrationCustomName='Enter an air conditioner name (1–100 characters).';
    if (!safeText(data.aircon_type)) errors[text('nodeFormAirconType') === '__custom__' ? 'registrationCustomType' : 'nodeFormAirconType'] = 'Enter an aircon type (1–100 characters).';
    if (data.brand.length > 80 || /[\x00-\x1f<>]/.test(data.brand)) errors.nodeFormBrand = 'Enter a valid manufacturer (up to 80 characters).';
    if (needsPassword) {
      const bytes = new TextEncoder().encode($('registrationWifiPassword').value || $('nodeFormPassword').value).length;
      if (bytes < 8 || bytes > 63) errors.registrationWifiPassword = 'Enter the current Wi-Fi password (8–63 bytes).';
    }
    return {data,errors,valid:Object.keys(errors).length === 0};
  }
  function showErrors(errors = {}) {
    ['nodeFormDeviceMode','registrationSensorConfig','nodeFormName','registrationAssignment','nodeFormAircon','registrationAcName','registrationCustomName','nodeFormAirconType','registrationCustomType','nodeFormBrand','registrationWifiPassword'].forEach(id => {
      const field = $(id), output = $(id + 'Error');
      field?.setAttribute('aria-invalid', String(!!errors[id]));
      if (output) { output.textContent = errors[id] || ''; output.hidden = !errors[id]; }
    });
    const first = Object.keys(errors)[0];
    if (first) $(first)?.focus();
  }
  function chooseMode(value) {
    document.querySelectorAll('input[name="registrationAssignment"]').forEach(radio => radio.checked = radio.value === value);
    $('registrationExistingAc').hidden = value !== 'existing';
    $('registrationNewAc').hidden = value !== 'new';
    onChange();
  }
  function setType(value) {
    const known = Array.from($('nodeFormAirconType').options).some(o => o.value === value && value !== '__custom__');
    $('nodeFormAirconType').value = known ? value : '__custom__';
    $('registrationCustomType').value = known ? '' : value || '';
    $('registrationCustomTypeWrap').hidden = known;
  }
  function hideBrands() { $('registrationBrandList').hidden = true; $('nodeFormBrand').setAttribute('aria-expanded','false'); $('nodeFormBrand').removeAttribute('aria-activedescendant'); index = -1; }
  function renderBrands() {
    const list = $('registrationBrandList'), input = $('nodeFormBrand'), query = input.value.trim().toLocaleLowerCase();
    const choices = brands.filter(brand => brand.toLocaleLowerCase().includes(query));
    list.replaceChildren(); index = -1; input.removeAttribute('aria-activedescendant');
    choices.forEach((brand,i) => {
      const option = document.createElement('button');
      option.type = 'button'; option.id = 'registrationBrandOption' + i; option.setAttribute('role','option');
      option.setAttribute('aria-selected',String(brand.toLocaleLowerCase() === query)); option.tabIndex = -1; option.textContent = brand;
      option.addEventListener('mousedown',event => event.preventDefault());
      option.addEventListener('click',() => { input.value = brand; hideBrands(); input.dispatchEvent(new Event('input',{bubbles:true})); hideBrands(); input.focus(); });
      list.appendChild(option);
    });
    if (!choices.length) { const empty=document.createElement('p'); empty.textContent='No matches. You can enter the manufacturer shown on your AC.'; list.appendChild(empty); }
    list.hidden = false; input.setAttribute('aria-expanded','true');
  }
  function addBrands(values) {
    const dedup = new Map();
    [...brands,...values].filter(v => typeof v === 'string' && v.trim() && !['Unspecified','Unassigned Brand'].includes(v.trim())).forEach(v => {const name=v.trim();if(!dedup.has(name.toLocaleLowerCase()))dedup.set(name.toLocaleLowerCase(),name);});
    brands = [...dedup.values()].sort((a,b) => a.localeCompare(b));
  }
  function mount(changed) {
    onChange = changed;
    $('nodeFormDeviceMode').addEventListener('change',()=>{ setDeviceMode(text('nodeFormDeviceMode')); onChange(); });
    addBrands(Array.from($('nodeBrandOptionsList').options).map(o => o.value));
    const brand = $('nodeFormBrand'); brand.removeAttribute('list');
    brand.addEventListener('focus',renderBrands); brand.addEventListener('input',renderBrands);
    brand.addEventListener('blur',hideBrands);
    brand.addEventListener('keydown',event => {
      if (event.key === 'Escape' && ! $('registrationBrandList').hidden) { event.preventDefault();event.stopPropagation();hideBrands();return; }
      if (!['ArrowDown','ArrowUp','Enter'].includes(event.key)) return;
      if ($('registrationBrandList').hidden) { if(event.key === 'Enter')return; renderBrands(); }
      const options=Array.from($('registrationBrandList').querySelectorAll('[role="option"]'));
      if(!options.length)return;
      event.preventDefault();
      if(event.key==='Enter') { if(index>=0) options[index].click(); return; }
      index=index<0 ? (event.key==='ArrowDown'?0:options.length-1) : (index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
      options.forEach((option,i)=>option.classList.toggle('active',i===index));
      brand.setAttribute('aria-activedescendant',options[index].id);options[index].scrollIntoView({block:'nearest'});
    });
    $('registrationPasswordToggle').addEventListener('click',() => {
      const field=$('registrationWifiPassword'),visible=field.type==='password';field.type=visible?'text':'password';
      $('registrationPasswordToggle').setAttribute('aria-pressed',String(visible));
      $('registrationPasswordToggle').setAttribute('aria-label',visible?'Hide password':'Show password');
      $('registrationPasswordToggle').classList.toggle('password-visible',visible);
    });
    document.querySelectorAll('input[name="registrationAssignment"]').forEach(r=>r.addEventListener('change',()=>chooseMode(r.value)));
    $('nodeFormAirconType').addEventListener('change',()=>{ $('registrationCustomTypeWrap').hidden=text('nodeFormAirconType')!=='__custom__'; onChange(); });
    $('nodeForm').addEventListener('input',onChange); $('nodeForm').addEventListener('change',onChange);
    $('nodeModal').addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const items=Array.from($('nodeModal').querySelectorAll('button,input,select,summary,[tabindex="0"]')).filter(el=>!el.disabled&&el.type!=='hidden'&&el.getClientRects().length);
      if(!items.length)return;
      if(event.shiftKey&&document.activeElement===items[0]) {event.preventDefault();items.at(-1).focus();}
      else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
    });
  }
  function reset() {
    setDeviceMode('');
    chooseMode('');showErrors();hideBrands();$('registrationCustomNameWrap').hidden=true;$('registrationCustomName').value='';$('registrationCustomTypeWrap').hidden=true;
    $('registrationWifiPassword').type='password';
    $('registrationPasswordToggle').setAttribute('aria-label','Show password');
    $('registrationPasswordToggle').setAttribute('aria-pressed','false');$('registrationPasswordToggle').classList.remove('password-visible');
  }
  function setDeviceMode(value, config={}) {
    $('nodeFormDeviceMode').value=value;
    $('registrationSensorConfig').hidden=!['monitoring','both'].includes(value);
    $('registrationIrConfig').hidden=value==='monitoring';
    for (const [id,key] of [['registrationPressureSensor','pressure_sensor'],['registrationPressureMin','pressure_min_pa'],['registrationPressureMax','pressure_max_pa']]) if (config[key]!==undefined) $(id).value=config[key];
  }
  root.EcoTrackControllerRegistration = {mount,reset,fields,validate,showErrors,chooseMode,setType,addBrands,type,setDeviceMode};
})(window);
