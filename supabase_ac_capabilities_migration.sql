-- Generated from config/ac-capabilities.json. Apply after cloud, realtime and registration migrations.
-- Adds one capability document to each existing AC; no profiles or assignments are recreated.
BEGIN;
ALTER TABLE public.aircons ADD COLUMN IF NOT EXISTS capability_profile jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION public.ecotrack_ac_registry()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $registry$
 SELECT $data${"schema_version":1,"registry_version":"irremote-2.9.0-1","library_version":"2.9.0","reference":"https://github.com/crankyoldgit/IRremoteESP8266/tree/v2.9.0/src","features":["power","temperature","turbo","quiet","eco","swing_vertical","swing_horizontal","sleep","display","filter","clean","beep","timer","i_feel"],"aliases":{"MIDEA_IR":"MIDEA","MITSUBISHI":"MITSUBISHI_AC","PANASONIC":"PANASONIC_AC","SAMSUNG":"SAMSUNG_AC","CARRIER":"CARRIER_AC64","HAIER":"HAIER_AC","HITACHI":"HITACHI_AC","FUJITSU":"FUJITSU_AC","TOSHIBA":"TOSHIBA_AC","SHARP":"SHARP_AC","WHIRLPOOL":"WHIRLPOOL_AC"},"protocols":{"TCL112AC":{"protocol":"TCL112AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":31,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1},"fan_decode_aliases":{"1":"quiet","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"TAC09CHSD","2":"GZ055BE1"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","filter","swing_vertical","swing_horizontal"]},"DAIKIN":{"protocol":"DAIKIN","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":true,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":10,"max":32,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","clean","swing_vertical","swing_horizontal"]},"DAIKIN2":{"protocol":"DAIKIN2","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":true,"beep":true,"timer":false,"i_feel":false},"temperature":{"min":10,"max":32,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false},"cool":{"min":18}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","display","filter","clean","beep","sleep","swing_vertical","swing_horizontal"]},"DAIKIN64":{"protocol":"DAIKIN64","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["cool","heat","dry"]},"modes":["cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"power_toggle":true,"decode_fields":["temp","mode","fan","turbo","quiet","sleep","swing_vertical"]},"DAIKIN216":{"protocol":"DAIKIN216","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":10,"max":32,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","swing_vertical","swing_horizontal"]},"GREE":{"protocol":"GREE","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":true,"display":true,"filter":false,"clean":true,"beep":false,"timer":false,"i_feel":true},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":1,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","2":"medium","5":"high"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"temperature_control":false,"fixed_temp":25},"dry":{"fixed_fan":"low"}},"models":{"1":"YAW1F","2":"YBOFB","3":"YX1FSF"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","clean","sleep","swing_vertical","swing_horizontal","i_feel"]},"MIDEA":{"protocol":"MIDEA","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":true,"filter":false,"clean":true,"beep":false,"timer":false,"i_feel":true},"temperature":{"min":17,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","eco","sleep","swing_vertical"]},"PANASONIC_AC":{"protocol":"PANASONIC_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"kPanasonicLke","2":"kPanasonicNke","3":"kPanasonicDke","4":"kPanasonicJke","5":"kPanasonicCkp","6":"kPanasonicRkr"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","filter","swing_vertical","swing_horizontal"]},"SAMSUNG_AC":{"protocol":"SAMSUNG_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":true,"beep":true,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"fixed_fan":"auto"}},"models":{},"model_rules":{},"notes":["Sleep requires a duration; boolean sleep is not encoded by this profile."],"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","display","filter","clean","beep","sleep","swing_vertical","swing_horizontal"]},"MITSUBISHI_AC":{"protocol":"MITSUBISHI_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":31,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","quiet","swing_vertical","swing_horizontal"]},"CARRIER_AC64":{"protocol":"CARRIER_AC64","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["cool","heat"]},"modes":["cool","heat","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","sleep","swing_vertical"]},"FUJITSU_AC":{"protocol":"FUJITSU_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1},"fan_decode_aliases":{"1":"quiet","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"ARRAH2E","2":"ARDB1","3":"ARREB1E","4":"ARJW2","5":"ARRY4","6":"ARREW4E"},"model_rules":{"1":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":128},"2":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":false},"full_state_min_bits":120},"3":{"temperature":{"step":0.25},"features":{"turbo":true,"eco":true,"swing_horizontal":false},"full_state_min_bits":128},"4":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":120},"5":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":128},"6":{"temperature":{"step":0.5},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":128}},"requires_model":true,"full_state_min_bits":128,"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","filter","clean","swing_vertical","swing_horizontal"]},"HAIER_AC":{"protocol":"HAIER_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":false,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["temp","mode","fan","filter","sleep","swing_vertical"]},"TOSHIBA_AC":{"protocol":"TOSHIBA_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":true,"swing_vertical":true,"swing_horizontal":false,"sleep":false,"display":false,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":17,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"kToshibaGenericRemote_B"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","filter"]},"SHARP_AC":{"protocol":"SHARP_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":false,"display":true,"filter":true,"clean":true,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":15,"max":30,"step":1,"unit":"C","modes":["cool","heat"]},"modes":["auto","cool","heat","dry"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"temperature_control":false},"dry":{"temperature_control":false}},"models":{"1":"A907","2":"A705","3":"A903"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","filter","clean","swing_vertical"]},"HITACHI_AC":{"protocol":"HITACHI_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":32,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","swing_vertical","swing_horizontal"]},"WHIRLPOOL_AC":{"protocol":"WHIRLPOOL_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":true,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":18,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"temperature_control":false,"fixed_fan":"auto"}},"models":{"1":"DG11J13A","2":"DG11J191"},"model_rules":{"1":{"temperature":{"min":18,"max":32}},"2":{"temperature":{"min":16,"max":30}}},"power_toggle":true,"decode_fields":["power","temp","mode","fan","turbo","display","sleep","swing_vertical"]},"TEKNOPOINT":{"protocol":"TEKNOPOINT","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":31,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1},"fan_decode_aliases":{"1":"quiet","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"TAC09CHSD","2":"GZ055BE1"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","filter","swing_vertical","swing_horizontal"]}},"verified_models":{}}$data$::jsonb
$registry$;
CREATE OR REPLACE FUNCTION public.ecotrack_resolve_ac_capabilities(p_protocol text,p_model integer,p_saved jsonb DEFAULT '{}',p_receiver jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE registry jsonb:=public.ecotrack_ac_registry(); name text:=upper(btrim(p_protocol)); base jsonb; rule jsonb; k text; v jsonb; matching boolean;
BEGIN
 name:=coalesce(registry->'aliases'->>name,name);
 base:=registry->'protocols'->name;
 IF base IS NULL THEN RETURN jsonb_build_object('protocol','UNKNOWN','can_transmit',false,'features','{}'::jsonb,'modes','[]'::jsonb,'fan_map','{}'::jsonb); END IF;
 rule:=base->'model_rules'->p_model::text;
 IF rule IS NOT NULL THEN
  FOR k,v IN SELECT key,value FROM jsonb_each(rule) LOOP
   base:=jsonb_set(base,ARRAY[k],CASE WHEN jsonb_typeof(v)='object' THEN coalesce(base->k,'{}')||v ELSE v END);
  END LOOP;
 END IF;
 matching:=p_saved->>'protocol'=name AND (p_saved->'remote_model' IS NULL OR p_saved->'remote_model'='null'::jsonb OR p_saved->>'remote_model'=p_model::text);
 FOR k IN SELECT jsonb_array_elements_text(registry->'features') LOOP
  IF p_receiver->k='false'::jsonb OR (k='swing_vertical' AND p_receiver->'swing'='false'::jsonb) THEN
    IF NOT (matching AND p_saved->'features'->k->>'status'='verified_supported') THEN base:=jsonb_set(base,ARRAY['features',k],'false'); END IF;
  END IF;
  IF matching AND p_saved->'features'->k->>'status'='verified_unsupported' THEN base:=jsonb_set(base,ARRAY['features',k],'false'); END IF;
 END LOOP;
 IF matching THEN
  FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_saved->'options'->'fan','{}')) LOOP
   IF v->>'status'='verified_unsupported' THEN base:=jsonb_set(base,ARRAY['fan_map'],(base->'fan_map')-k); END IF;
  END LOOP;
  base:=jsonb_set(base,ARRAY['modes'],coalesce((SELECT jsonb_agg(value) FROM jsonb_array_elements(base->'modes') WHERE coalesce(p_saved->'options'->'mode'->(value#>>'{}')->>'status','')<>'verified_unsupported'),'[]'));
  IF p_saved->'temperature'->>'status'='verified_supported' THEN
   base:=jsonb_set(base,ARRAY['temperature'],(base->'temperature')||jsonb_build_object('min',p_saved->'temperature'->'min','max',p_saved->'temperature'->'max','step',p_saved->'temperature'->'step'));
  END IF;
 END IF;
 RETURN base||jsonb_build_object('protocol',name,'remote_model',p_model,'can_transmit',coalesce((base->>'requires_model')::boolean,false)=false OR coalesce(base->'models' ? p_model::text,false));
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_validate_ac_intent(p_ac public.aircons,p_live jsonb,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE registry jsonb:=public.ecotrack_ac_registry(); name text; model integer; caps jsonb; state jsonb:=p_payload->'state'; rule jsonb; temp numeric; lo numeric; hi numeric; step numeric; k text; feat text;
BEGIN
 name:=coalesce(nullif(p_live->>'protocol','UNKNOWN'),p_ac.protocol_name,p_ac.protocol,'UNKNOWN');
 name:=coalesce(registry->'aliases'->>upper(name),upper(name));
 IF coalesce(registry->'aliases'->>upper(p_payload->>'protocol'),upper(p_payload->>'protocol')) IS DISTINCT FROM name THEN RAISE EXCEPTION 'Protocol differs from the active receiver/profile'; END IF;
 IF p_ac.capability_profile->>'protocol'=name AND p_ac.capability_profile->'model_verified'='true'::jsonb THEN
  model:=(p_ac.capability_profile->>'remote_model')::integer;
 ELSE model:=coalesce((p_live->>'remote_model')::integer,(p_ac.capability_profile->>'remote_model')::integer); END IF;
 IF p_payload->'model' IS NOT NULL AND p_payload->'model'<>'null'::jsonb AND (jsonb_typeof(p_payload->'model')<>'number' OR (p_payload->>'model')::numeric IS DISTINCT FROM model) THEN RAISE EXCEPTION 'Remote model differs from the active profile'; END IF;
 IF p_payload ? 'capability_revision' AND (jsonb_typeof(p_payload->'capability_revision') IS DISTINCT FROM 'number' OR coalesce(p_payload->>'capability_revision','') !~ '^[0-9]{1,9}$' OR (p_payload->>'capability_revision')::integer<>coalesce((p_ac.capability_profile->>'revision')::integer,0)) THEN RAISE EXCEPTION 'Capabilities changed; refresh this AC before sending'; END IF;
 IF p_payload ? 'registry_version' AND p_payload->>'registry_version' IS DISTINCT FROM registry->>'registry_version' THEN RAISE EXCEPTION 'Capability registry version differs; refresh the application'; END IF;
 caps:=public.ecotrack_resolve_ac_capabilities(name,model,p_ac.capability_profile,p_live->'ac_capabilities');
 IF caps->'can_transmit'<>'true'::jsonb THEN RAISE EXCEPTION 'Choose a supported exact protocol/model'; END IF;
 IF jsonb_typeof(state) IS DISTINCT FROM 'object' OR coalesce(state->>'power','') NOT IN ('on','off') OR
  NOT (caps->'modes' ? coalesce(state->>'mode','')) OR NOT(caps->'fan_map' ? coalesce(state->>'fan','')) OR jsonb_typeof(state->'temp') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid full AC state or unsupported mode/fan'; END IF;
 IF p_payload ? 'requested_feature' THEN
  k:=lower(p_payload->>'requested_feature');feat:=CASE WHEN k='temp' THEN 'temperature' WHEN k='swing' THEN 'swing_vertical' ELSE k END;
  IF k NOT IN ('mode','fan') AND (NOT(registry->'features' ? feat) OR caps->'features'->feat IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'Requested feature is unsupported: %',k; END IF;
  IF feat='temperature' AND (coalesce(caps->'mode_rules'->(state->>'mode')->'temperature_control','true')<>'true'::jsonb OR NOT(caps->'temperature'->'modes' ? (state->>'mode'))) THEN RAISE EXCEPTION 'Temperature is not adjustable in this mode'; END IF;
 END IF;
 rule:=coalesce(caps->'mode_rules'->(state->>'mode'),'{}');
 lo:=greatest((caps->'temperature'->>'min')::numeric,(rule->>'min')::numeric);
 hi:=least((caps->'temperature'->>'max')::numeric,(rule->>'max')::numeric);
 lo:=coalesce((rule->>'fixed_temp')::numeric,lo);hi:=coalesce((rule->>'fixed_temp')::numeric,hi);
 step:=(caps->'temperature'->>'step')::numeric;temp:=(state->>'temp')::numeric;
 IF lo IS NULL OR hi IS NULL OR step IS NULL OR temp<lo OR temp>hi OR abs((temp-lo)/step-round((temp-lo)/step))>0.000001 THEN RAISE EXCEPTION 'Temperature must be %..% C in % degree steps',lo,hi,step; END IF;
 IF rule ? 'fixed_fan' AND state->>'fan'<>rule->>'fixed_fan' THEN RAISE EXCEPTION 'This mode requires % fan',rule->>'fixed_fan'; END IF;
 FOR k IN SELECT jsonb_object_keys(state) LOOP
  IF k IN ('power','temp','mode','fan') THEN CONTINUE; END IF;
  feat:=CASE WHEN k='swing' THEN 'swing_vertical' ELSE k END;
  IF NOT(registry->'features' ? feat) OR coalesce(state->>k,'') NOT IN ('on','off') OR (state->>k='on' AND caps->'features'->feat IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'Unsupported or invalid AC setting: %',k; END IF;
 END LOOP;
 RETURN jsonb_build_object('resolved_model',model,'capability_constraints',jsonb_build_object('protocol',name,'model',model,'min',lo,'max',hi,'step',step,'revision',coalesce((p_ac.capability_profile->>'revision')::integer,0)));
END $$;

CREATE OR REPLACE FUNCTION public.ecotrack_verify_ac_capabilities(p_aircon_id text,p_expected_revision integer,p_profile jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ac public.aircons; live jsonb; registry jsonb:=public.ecotrack_ac_registry(); caps jsonb; clean jsonb; kind text; k text; v jsonb; status text; model integer; t jsonb; b jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO ac FROM public.aircons WHERE id=p_aircon_id FOR UPDATE;
 IF ac.id IS NULL THEN RAISE EXCEPTION 'AC profile no longer exists'; END IF;
 IF p_expected_revision IS NULL OR p_expected_revision<0 THEN RAISE EXCEPTION 'Invalid capability revision'; END IF;
 IF coalesce((ac.capability_profile->>'revision')::integer,0)<>p_expected_revision THEN RAISE EXCEPTION 'Capabilities changed; reopen verification before saving'; END IF;
 IF jsonb_typeof(p_profile) IS DISTINCT FROM 'object' OR octet_length(p_profile::text)>12000 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_profile) AS keys(item) WHERE keys.item NOT IN ('protocol','remote_model','model_verified','ac_model','features','options','temperature')) THEN RAISE EXCEPTION 'Invalid capability document'; END IF;
 SELECT s.latest_ir INTO live FROM public.ecotrack_device_state s JOIN public.nodes n ON n.id=s.node_id
  WHERE ac.controller_node_id=n.id OR ac.node_id IN(n.id,n.name) LIMIT 1;
 IF coalesce(live->>'protocol','UNKNOWN')<>'UNKNOWN' AND p_profile->>'protocol' IS DISTINCT FROM live->>'protocol' THEN RAISE EXCEPTION 'Protocol differs from this controller receiver'; END IF;
 IF NOT(registry->'protocols' ? coalesce(p_profile->>'protocol','')) THEN RAISE EXCEPTION 'Select an audited exact protocol'; END IF;
 IF p_profile->'remote_model' IS NOT NULL AND p_profile->'remote_model'<>'null'::jsonb THEN
  IF jsonb_typeof(p_profile->'remote_model')<>'number' OR (p_profile->>'remote_model') !~ '^[1-9][0-9]{0,4}$' THEN RAISE EXCEPTION 'Invalid remote model'; END IF;
  model:=(p_profile->>'remote_model')::integer;
  IF NOT(registry->'protocols'->(p_profile->>'protocol')->'models' ? model::text) THEN RAISE EXCEPTION 'Remote model is not defined by this protocol'; END IF;
 END IF;
 IF p_profile ? 'model_verified' AND jsonb_typeof(p_profile->'model_verified')<>'boolean' THEN RAISE EXCEPTION 'Invalid model confirmation'; END IF;
 IF coalesce(p_profile->>'ac_model','') ~ '[<>[:cntrl:]]' OR length(coalesce(p_profile->>'ac_model',''))>100 THEN RAISE EXCEPTION 'Invalid physical AC model'; END IF;
 caps:=public.ecotrack_resolve_ac_capabilities(p_profile->>'protocol',model,'{}');
 clean:=jsonb_build_object('protocol',p_profile->>'protocol','remote_model',model,'model_verified',coalesce(p_profile->'model_verified','false'::jsonb),'ac_model',p_profile->>'ac_model','features','{}'::jsonb,'options',jsonb_build_object('mode','{}'::jsonb,'fan','{}'::jsonb));
 IF p_profile ? 'features' AND jsonb_typeof(p_profile->'features')<>'object' THEN RAISE EXCEPTION 'Invalid feature results'; END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_profile->'features','{}')) LOOP
  status:=v->>'status';
  IF NOT(registry->'features' ? k) OR coalesce(status,'') NOT IN ('verified_supported','verified_unsupported','unknown','library_unverified') THEN RAISE EXCEPTION 'Invalid feature result'; END IF;
  IF status LIKE 'verified_%' THEN clean:=jsonb_set(clean,ARRAY['features',k],jsonb_build_object('status',status,'source','physical_test','confidence','user_confirmed','verified_by',auth.uid(),'verified_at',clock_timestamp())); END IF;
 END LOOP;
 IF p_profile ? 'options' AND (jsonb_typeof(p_profile->'options')<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_profile->'options') AS keys(item) WHERE keys.item NOT IN ('mode','fan'))) THEN RAISE EXCEPTION 'Invalid option results'; END IF;
 FOREACH kind IN ARRAY ARRAY['mode','fan'] LOOP
  FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_profile->'options'->kind,'{}')) LOOP
   status:=v->>'status';
   IF NOT(CASE WHEN kind='mode' THEN caps->'modes' ELSE caps->'fan_map' END ? k) OR coalesce(status,'') NOT IN ('verified_supported','verified_unsupported','unknown','library_unverified') THEN RAISE EXCEPTION 'Invalid mode/fan result'; END IF;
   IF status LIKE 'verified_%' THEN clean:=jsonb_set(clean,ARRAY['options',kind,k],jsonb_build_object('status',status,'source','physical_test','confidence','user_confirmed','verified_by',auth.uid(),'verified_at',clock_timestamp())); END IF;
  END LOOP;
 END LOOP;
 t:=p_profile->'temperature';b:=caps->'temperature';
 IF t IS NOT NULL AND t<>'null'::jsonb THEN
  IF t->>'status' IS DISTINCT FROM 'verified_supported' OR jsonb_typeof(t->'min')<>'number' OR jsonb_typeof(t->'max')<>'number' OR jsonb_typeof(t->'step')<>'number' THEN RAISE EXCEPTION 'Invalid verified temperature range'; END IF;
  IF (t->>'min')::numeric<(b->>'min')::numeric OR (t->>'max')::numeric>(b->>'max')::numeric OR (t->>'min')::numeric>(t->>'max')::numeric OR (t->>'step')::numeric<(b->>'step')::numeric OR mod((t->>'step')::numeric,(b->>'step')::numeric)<>0 OR mod((t->>'min')::numeric-(b->>'min')::numeric,(b->>'step')::numeric)<>0 THEN RAISE EXCEPTION 'Verified range must fit the encoder range and steps'; END IF;
  clean:=clean||jsonb_build_object('temperature',jsonb_build_object('status','verified_supported','min',t->'min','max',t->'max','step',t->'step','unit','C','source','physical_test','confidence','user_confirmed','verified_at',clock_timestamp(),'verified_by',auth.uid()));
 END IF;
 clean:=clean||jsonb_build_object('revision',p_expected_revision+1,'updated_at',clock_timestamp(),'registry_version',registry->>'registry_version');
 PERFORM set_config('ecotrack.capability_write','on',true);
 UPDATE public.aircons SET capability_profile=clean WHERE id=ac.id RETURNING * INTO ac;
 RETURN jsonb_build_object('success',true,'aircon',to_jsonb(ac));
END $$;
CREATE OR REPLACE FUNCTION public.ecotrack_guard_ac_capabilities()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.capability_profile<>'{}'::jsonb AND coalesce(current_setting('ecotrack.capability_write',true),'')<>'on' THEN
   RAISE EXCEPTION 'Use the admin capability verification action' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.capability_profile IS DISTINCT FROM OLD.capability_profile AND coalesce(current_setting('ecotrack.capability_write',true),'')<>'on' THEN
  RAISE EXCEPTION 'Use the admin capability verification action' USING ERRCODE='42501';
 END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ecotrack_ac_capabilities_guard ON public.aircons;
CREATE TRIGGER ecotrack_ac_capabilities_guard BEFORE INSERT OR UPDATE ON public.aircons FOR EACH ROW EXECUTE FUNCTION public.ecotrack_guard_ac_capabilities();
REVOKE ALL ON FUNCTION public.ecotrack_verify_ac_capabilities(text,integer,jsonb),public.ecotrack_validate_ac_intent(public.aircons,jsonb,jsonb),public.ecotrack_guard_ac_capabilities() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ecotrack_verify_ac_capabilities(text,integer,jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.ecotrack_cloud_request(p_node_id text,p_kind text,p_payload jsonb,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.nodes; s public.ecotrack_device_state; c public.ecotrack_device_commands; ac public.aircons; seconds numeric; state jsonb; life interval; chosen_value numeric; chosen_unit text;
BEGIN
 IF auth.uid() IS NULL OR NOT public.ecotrack_is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('ping','learn_ir','configure','ac_intent') OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid hardware request'; END IF;
 SELECT * INTO n FROM public.nodes WHERE id=p_node_id FOR UPDATE;
 SELECT * INTO s FROM public.ecotrack_device_state WHERE node_id=p_node_id;
 IF n.id IS NULL OR s.node_id IS NULL THEN RAISE EXCEPTION 'Provision this controller through Bluetooth first'; END IF;
 SELECT * INTO c FROM public.ecotrack_device_commands WHERE id=p_request_id;
 IF c.id IS NOT NULL THEN
  IF c.node_id<>p_node_id OR c.kind<>p_kind OR (c.payload-'resolved_model'-'capability_constraints')<>p_payload OR c.created_by<>auth.uid() THEN RAISE EXCEPTION 'Request ID conflict'; END IF;
  RETURN to_jsonb(c);
 END IF;
 IF p_kind='configure' THEN
  IF jsonb_typeof(p_payload->'interval_seconds') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid report interval'; END IF;
  seconds := (p_payload->>'interval_seconds')::numeric;
  IF seconds<1 OR seconds>86400 OR seconds<>trunc(seconds) THEN RAISE EXCEPTION 'Report interval must be 1..86400 seconds'; END IF;
  IF coalesce(p_payload->>'wake_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR coalesce(p_payload->>'sleep_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'Invalid wake/sleep time'; END IF;
  chosen_value := seconds; chosen_unit := 'Seconds';
  IF p_payload ? 'interval_val' OR p_payload ? 'interval_unit' THEN
   IF jsonb_typeof(p_payload->'interval_val') IS DISTINCT FROM 'number' OR coalesce(p_payload->>'interval_unit','') NOT IN ('Seconds','Minutes','Hours') THEN RAISE EXCEPTION 'Invalid interval unit/value'; END IF;
   chosen_value := (p_payload->>'interval_val')::numeric; chosen_unit := p_payload->>'interval_unit';
   IF chosen_value<=0 OR chosen_value<>trunc(chosen_value) OR chosen_value * (CASE chosen_unit WHEN 'Seconds' THEN 1 WHEN 'Minutes' THEN 60 ELSE 3600 END) <> seconds THEN RAISE EXCEPTION 'Interval unit/value does not match seconds'; END IF;
  END IF;
  UPDATE public.nodes SET interval_val=chosen_value,interval_unit=chosen_unit,wake_time=p_payload->>'wake_time',sleep_time=p_payload->>'sleep_time',updated=now() WHERE id=n.id;
  life := interval '1 day';
 ELSIF p_kind='ac_intent' THEN
  IF coalesce((s.capabilities->>'ir_transmitter')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'This device is receiver-only; an IR transmitter is required'; END IF;
  SELECT * INTO ac FROM public.aircons WHERE id=p_payload->>'aircon_id' AND (node_id=n.id OR controller_node_id=n.id OR node_id=n.name) FOR UPDATE;
  state := p_payload->'state';
  IF ac.id IS NULL THEN RAISE EXCEPTION 'AC is not assigned to this controller'; END IF;
  p_payload:=p_payload||public.ecotrack_validate_ac_intent(ac,s.latest_ir,p_payload);
  UPDATE public.aircons SET desired_state=state,command_id=p_request_id,command_status='queued',command_status_at=now(),commanded_at=now() WHERE id=ac.id;
  life := interval '2 minutes';
 ELSIF p_kind='learn_ir' THEN
  IF coalesce((s.capabilities->>'ir_receiver')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'IR receiver capability has not been reported'; END IF;
  life := interval '30 seconds';
 ELSE life := interval '20 seconds';
 END IF;
 IF p_kind IN ('configure','ac_intent') THEN
  UPDATE public.ecotrack_device_commands SET status='superseded',result=jsonb_build_object('error','Replaced by newer settings') WHERE node_id=n.id AND kind=p_kind AND status IN ('queued','claimed');
 END IF;
 INSERT INTO public.ecotrack_device_commands(id,node_id,kind,payload,created_by,expires_at) VALUES(p_request_id,n.id,p_kind,p_payload,auth.uid(),now()+life) RETURNING * INTO c;
 RETURN to_jsonb(c);
END $$;
CREATE OR REPLACE FUNCTION public.ecotrack_device_observe(p_device_id text,p_token text,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE target text; current_state public.ecotrack_device_state; latest jsonb; field text; seen timestamptz;
BEGIN
 SELECT node_id INTO target FROM ecotrack_private.device_credentials
 WHERE device_id=p_device_id AND p_token ~ '^[a-f0-9]{64}$' AND token_hash=sha256(convert_to(p_token,'UTF8'));
 IF target IS NULL THEN RAISE EXCEPTION 'Invalid device credential' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_observation) IS DISTINCT FROM 'object' OR octet_length(p_observation::text)>4000
  OR p_observation ? 'raw_data' OR p_observation ? 'last_decoded'
  OR coalesce(p_observation->>'protocol','') !~ '^[A-Z][A-Z0-9_]{1,48}$' OR p_observation->>'protocol'='UNKNOWN'
  OR coalesce(p_observation->>'frame_kind','') NOT IN ('full_state','partial_state')
  OR jsonb_typeof(p_observation->'raw_count') IS DISTINCT FROM 'number'
  OR coalesce(p_observation->>'raw_count','') !~ '^[1-9][0-9]{0,3}$'
  OR jsonb_typeof(p_observation->'sequence') IS DISTINCT FROM 'number'
  OR coalesce(p_observation->>'sequence','') !~ '^[0-9]{1,10}$'
  OR jsonb_typeof(p_observation->'boot_count') IS DISTINCT FROM 'number'
  OR coalesce(p_observation->>'boot_count','') !~ '^[0-9]{1,10}$'
  OR jsonb_typeof(p_observation->'state') IS DISTINCT FROM 'object'
  OR (p_observation->'state' ? 'power' AND jsonb_typeof(p_observation->'state'->'power') IS DISTINCT FROM 'boolean')
  OR (p_observation->'state' ? 'temp' AND jsonb_typeof(p_observation->'state'->'temp') IS DISTINCT FROM 'number')
  OR (p_observation->'state' ? 'mode' AND coalesce(p_observation->'state'->>'mode','') NOT IN ('cool','dry','fan','auto','heat'))
  OR (p_observation->'state' ? 'fan' AND coalesce(p_observation->'state'->>'fan','') NOT IN ('auto','low','medium','high','max','quiet','silent','turbo'))
  OR p_observation->'state'->>'source' IS DISTINCT FROM 'ir_receiver' THEN
  RAISE EXCEPTION 'Invalid decoded IR observation';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_observation->'state') f WHERE f<>'source') THEN RAISE EXCEPTION 'No decoded fields'; END IF;
 IF p_observation ? 'remote_model' AND p_observation->'remote_model'<>'null'::jsonb AND (jsonb_typeof(p_observation->'remote_model')<>'number' OR (p_observation->>'remote_model') !~ '^[1-9][0-9]{0,4}$') THEN RAISE EXCEPTION 'Invalid decoded model'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_observation->'state') f WHERE f NOT IN ('source','power','temp','mode','fan','turbo','swing','eco','sleep','quiet','swing_vertical','swing_horizontal','display','filter','clean','beep','i_feel')) THEN RAISE EXCEPTION 'Unknown decoded field'; END IF;
 IF (p_observation->'state'->>'temp')::numeric NOT BETWEEN 0 AND 50 THEN RAISE EXCEPTION 'Invalid IR temperature'; END IF;
 FOREACH field IN ARRAY ARRAY['turbo','swing','eco','sleep','quiet','swing_vertical','swing_horizontal','display','filter','clean','beep','i_feel'] LOOP
  IF p_observation->'state' ? field AND jsonb_typeof(p_observation->'state'->field) IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'Invalid IR feature';
  END IF;
 END LOOP;
 IF p_observation ? 'captured_at_epoch_ms' AND
  (jsonb_typeof(p_observation->'captured_at_epoch_ms') IS DISTINCT FROM 'number' OR
   coalesce(p_observation->>'captured_at_epoch_ms','') !~ '^[0-9]{13}$') THEN RAISE EXCEPTION 'Invalid IR capture timestamp'; END IF;
 SELECT * INTO current_state FROM public.ecotrack_device_state WHERE node_id=target AND device_id=p_device_id FOR UPDATE;
 IF current_state.node_id IS NULL THEN RAISE EXCEPTION 'Register this controller first'; END IF;
 -- Capture time also rejects an old boot's delayed upload after a newer boot has reported.
 IF coalesce(current_state.latest_ir->>'captured_at_epoch_ms','') ~ '^[0-9]{13}$'
  AND coalesce(p_observation->>'captured_at_epoch_ms','') ~ '^[0-9]{13}$'
  AND (current_state.latest_ir->>'captured_at_epoch_ms')::numeric > (p_observation->>'captured_at_epoch_ms')::numeric THEN
  RETURN jsonb_build_object('success',true,'node_id',target,'duplicate',true,'server_time',clock_timestamp());
 END IF;
 -- Retried or reordered uploads from one boot cannot roll back newer receiver state.
 IF current_state.latest_ir->>'boot_count'=p_observation->>'boot_count'
  AND coalesce(current_state.latest_ir->>'sequence','') ~ '^[0-9]{1,10}$'
  AND (current_state.latest_ir->>'sequence')::numeric >= (p_observation->>'sequence')::numeric THEN
  RETURN jsonb_build_object('success',true,'node_id',target,'duplicate',true,'server_time',clock_timestamp());
 END IF;
 seen := clock_timestamp();
 latest := p_observation || jsonb_build_object('received_at',seen,'node_id',target);
 -- Carry known fields across partial frames, retaining the time each field was actually decoded.
 IF current_state.latest_ir->>'protocol'=p_observation->>'protocol' THEN
  latest:=jsonb_set(latest,ARRAY['state'],coalesce(current_state.latest_ir->'state','{}')||(p_observation->'state'));
 END IF;
 latest:=jsonb_set(latest,ARRAY['field_at'],coalesce(CASE WHEN current_state.latest_ir->>'protocol'=p_observation->>'protocol' THEN current_state.latest_ir->'field_at' END,'{}')||
   (SELECT jsonb_object_agg(f,coalesce(to_jsonb(to_timestamp((p_observation->>'captured_at_epoch_ms')::numeric/1000)),to_jsonb(seen))) FROM jsonb_object_keys(p_observation->'state') f WHERE f<>'source'));
 UPDATE public.ecotrack_device_state SET latest_ir=latest,last_seen=seen,sleeping_until=NULL WHERE node_id=target;
 RETURN jsonb_build_object('success',true,'node_id',target,'server_time',seen);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
