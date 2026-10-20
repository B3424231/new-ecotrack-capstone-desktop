/* Shared controller location selection and confirmed Supabase persistence. */
(function(root) {
  'use strict';
  const levels = ['Building', 'Floor', 'Room'];
  const table = {Building:'buildings',Floor:'floors',Room:'rooms'};
  const clean = value => String(value || '').trim();
  function bind(prefix, cache, initial = {}, onChange = () => {}) {
    const get = name => root.document.getElementById(prefix + name);
    const rows = level => cache[table[level]] || [];
    const setOptions = (level, available, value = '') => {
      const select = get(level);
      select.replaceChildren();
      for (const row of [{id:'',name:'Unassigned'}, ...available, {id:'custom',name:'+ Add ' + level.toLowerCase() + '...'}]) {
        const option = root.document.createElement('option');
        option.value = row.id; option.textContent = row.name;
        select.appendChild(option);
      }
      select.value = [...select.options].some(option => option.value === value) ? value : '';
      get('Custom' + level).classList.toggle('hidden', select.value !== 'custom');
    };
    const renderRooms = (value = '') => {
      const floorId = get('Floor').value;
      setOptions('Room', floorId && floorId !== 'custom' ? rows('Room').filter(row => row.floor_id === floorId) : [], value);
      onChange();
    };
    const renderFloors = (floorId = '', roomId = '') => {
      const buildingId = get('Building').value;
      setOptions('Floor', buildingId && buildingId !== 'custom' ? rows('Floor').filter(row => row.building_id === buildingId) : [], floorId);
      renderRooms(roomId);
    };
    let room = rows('Room').find(row => row.id === initial.room_id);
    let floor = rows('Floor').find(row => row.id === (room?.floor_id || initial.floor_id));
    let building = rows('Building').find(row => row.id === (floor?.building_id || initial.building_id));
    const findName = (level, name, parent = {}) => {
      const matches = rows(level).filter(row => clean(row.name).toLowerCase() === clean(name).toLowerCase() &&
        Object.entries(parent).every(([key,value]) => row[key] === value));
      return matches.length === 1 ? matches[0] : null;
    };
    if (!building && initial.building) building = findName('Building', initial.building);
    if (!floor && building && initial.floor) floor = findName('Floor', initial.floor, {building_id:building.id});
    if (!room && floor && initial.room_name) room = findName('Room', initial.room_name, {floor_id:floor.id});
    const custom = (level, name, row) => {
      const realName = clean(name);
      get('Custom' + level).value = row ? '' : realName;
      return row?.id || (realName && !['unassigned','unknown'].includes(realName.toLowerCase()) ? 'custom' : '');
    };
    setOptions('Building', rows('Building'), custom('Building', initial.building, building));
    renderFloors(custom('Floor', initial.floor, floor), custom('Room', initial.room_name, room));
    for (const level of levels) {
      get(level).onchange = () => {
        get('Custom' + level).classList.toggle('hidden', get(level).value !== 'custom');
        if (get(level).value === 'custom') get('Custom' + level).focus();
        if (level === 'Building') renderFloors();
        else if (level === 'Floor') renderRooms();
        else onChange();
      };
    }
    return () => renderFloors(get('Floor').value,get('Room').value);
  }
  function selection(prefix, cache) {
    const get = name => root.document.getElementById(prefix + name);
    const result = {};
    for (const level of levels) {
      const id = get(level).value;
      const name = id === 'custom' ? clean(get('Custom' + level).value) :
        (cache[table[level]] || []).find(row => row.id === id)?.name || 'Unassigned';
      if (id === 'custom' && !name) {
        get('Custom' + level).focus();
        throw new Error('Enter a name for the new ' + level.toLowerCase() + '.');
      }
      result[level] = {id,name};
    }
    const any = levels.some(level => result[level].id);
    if (any && levels.some(level => !result[level].id)) throw new Error('Choose a building, floor, and room, or leave the whole location unassigned.');
    if (result.Floor.id && result.Floor.id !== 'custom') {
      const floor = (cache.floors || []).find(row => row.id === result.Floor.id);
      if (!floor || floor.building_id !== result.Building.id) throw new Error('The selected floor does not belong to this building.');
    }
    if (result.Room.id && result.Room.id !== 'custom') {
      const room = (cache.rooms || []).find(row => row.id === result.Room.id);
      if (!room || room.floor_id !== result.Floor.id) throw new Error('The selected room does not belong to this floor.');
    }
    return result;
  }
  async function resolve(prefix, cache, client) {
    const chosen = selection(prefix,cache);
    if (!client?.from) throw new Error('Connect to Supabase to save the deployment location.');
    const confirmed = {};
    for (const level of levels) {
      const pick = chosen[level];
      if (!pick.id) { confirmed[level] = null; continue; }
      const parent = level === 'Floor' ? {building_id:confirmed.Building.id} :
        level === 'Room' ? {floor_id:confirmed.Floor.id} : {};
      let data,error;
      if (pick.id === 'custom') {
        const existing = (cache[table[level]] || []).find(row => clean(row.name).toLowerCase() === pick.name.toLowerCase() &&
          Object.entries(parent).every(([key,value]) => row[key] === value));
        if (existing) ({data,error} = await client.from(table[level]).select('*').eq('id',existing.id).maybeSingle());
        else ({data,error} = await client.from(table[level]).insert([{name:pick.name,...parent}]).select('*').single());
      } else ({data,error} = await client.from(table[level]).select('*').eq('id',pick.id).maybeSingle());
      if (error || !data?.id || !Object.entries(parent).every(([key,value]) => data[key] === value))
        throw new Error(error?.message || 'The selected ' + level.toLowerCase() + ' is no longer available. Reload the locations and try again.');
      if (!cache[table[level]].some(row => row.id === data.id)) cache[table[level]].push(data);
      confirmed[level] = data;
    }
    return {
      building_id:confirmed.Building?.id || null, building:confirmed.Building?.name || 'Unassigned',
      floor_id:confirmed.Floor?.id || null, floor:confirmed.Floor?.name || 'Unassigned',
      room_id:confirmed.Room?.id || null, room_name:confirmed.Room?.name || 'Unassigned',
      location:confirmed.Room ? confirmed.Room.name + ' (' + confirmed.Building.name + ' / ' + confirmed.Floor.name + ')' : 'Unassigned'
    };
  }
  root.EcoTrackControllerLocations = {bind,selection,resolve};
})(typeof window === 'undefined' ? globalThis : window);
