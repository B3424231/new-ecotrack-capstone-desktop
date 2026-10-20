'use strict';
// Uses the existing signed-in administrator client and its database policies.
async function createSensorAsset(client, input) {
  if (!input || typeof input !== 'object') throw new Error('Enter the AC asset details.');
  const payload = {};
  for (const field of ['asset_tag', 'name', 'brand', 'model', 'aircon_type']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].trim().length > 160) throw new Error('AC name, asset tag, brand, model and type are required (up to 160 characters).');
    payload[field] = input[field].trim();
  }
  Object.assign(payload, { node_id: null, controller_node_id: null, protocol: null, protocol_name: null,
    status: 'unlinked', cooling_capacity_hp: null, install_date: null });
  const { data, error } = await client.from('aircons').insert(payload)
    .select('id,name,asset_tag,node_id,controller_node_id,protocol,protocol_name').single();
  if (error) throw new Error(error.code === '23505' ? 'That AC asset tag already exists. Choose it from the AC list.' : error.message || 'AC registration failed.');
  if (!data?.id || data.asset_tag !== payload.asset_tag || data.name !== payload.name ||
      data.node_id !== null || data.controller_node_id !== null || data.protocol !== null || data.protocol_name !== null) throw new Error('Controller-free AC registration was not confirmed. Refresh the AC registry before trying again.');
  return { success: true, data: { id: data.id, name: data.name, asset_tag: data.asset_tag } };
}
module.exports = { createSensorAsset };
