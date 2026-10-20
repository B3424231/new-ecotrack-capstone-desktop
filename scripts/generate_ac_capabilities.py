from pathlib import Path
import json,sys,copy
root=Path(__file__).resolve().parent.parent
data=json.loads((root/'config/ac-capabilities.json').read_text(encoding='utf-8'))
data['aliases'].pop('TCL',None)
if 'TEKNOPOINT' not in data['protocols']:
    data['protocols']['TEKNOPOINT']=copy.deepcopy(data['protocols']['TCL112AC'])
    data['protocols']['TEKNOPOINT']['protocol']='TEKNOPOINT'
if '--check' not in sys.argv:(root/'config/ac-capabilities.json').write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
resolver=(root/'public/js/ac-capability-registry.source.js').read_text(encoding='utf-8').replace('/* AC_CAPABILITY_DATA */ {}',json.dumps(data,separators=(',',':')))
wrapper=(root/'config/ac-capability-engine.source.js').read_text(encoding='utf-8')
block='  // ===== CAPABILITY ENGINE =====\n'+resolver+'\n'+wrapper+'\n'
path=root/'public/js/aircon-system.js'
source=path.read_text(encoding='utf-8')
start=source.index('  // ===== CAPABILITY ENGINE =====')
end=source.index('  // ===== PROTOCOL ADAPTER & IR SERVICE =====',start)
next_source=source[:start]+block+source[end:]
state=(root/'public/js/aircon-state.js').read_text(encoding='utf-8')
boundary=source.index('})(typeof window',0)
boundary=source.index('\n',boundary)+1
next_boundary=next_source.index('})(typeof window')
next_boundary=next_source.index('\n',next_boundary)+1
next_source=state.rstrip()+'\n'+next_source[next_boundary:]
if '--check' in sys.argv:
    if next_source!=source: raise SystemExit('Generated registry or state helper drift')
else:
    backup=root/'reports/multi-brand-capabilities/before/public/js/aircon-system.js'
    backup.parent.mkdir(parents=True,exist_ok=True)
    if not backup.exists():backup.write_bytes(path.read_bytes())
    path.write_text(next_source,encoding='utf-8',newline='\r\n')
print('Capability registry/state generation OK: '+str(len(data['protocols']))+' exact protocols')

# Additional generated firmware/SQL outputs are derived from the same exact-profile data.
sql=(root/'config/ac-capabilities.sql.source').read_text(encoding='utf-8').replace('/* AC_REGISTRY_JSON */',json.dumps(data,separators=(',',':')))
cloud=(root/'supabase_cloud_hardware_migration.sql').read_text(encoding='utf-8')
a=cloud.index('CREATE OR REPLACE FUNCTION public.ecotrack_cloud_request')
b=cloud.index('END $$;',a)+len('END $$;')
request=cloud[a:b]
a=request.index("  IF ac.id IS NULL OR jsonb_typeof(state)")
b=request.index("  UPDATE public.aircons SET desired_state",a)
request=request[:a]+"""  IF ac.id IS NULL THEN RAISE EXCEPTION 'AC is not assigned to this controller'; END IF;
  p_payload:=p_payload||public.ecotrack_validate_ac_intent(ac,s.latest_ir,p_payload);
"""+request[b:]
request=request.replace('c.payload<>p_payload',"(c.payload-'resolved_model'-'capability_constraints')<>p_payload")
observe=(root/'supabase_ir_realtime_migration.sql').read_text(encoding='utf-8')
a=observe.index('CREATE OR REPLACE FUNCTION public.ecotrack_device_observe')
b=observe.index('END $$;',a)+len('END $$;')
observe=observe[a:b].replace("p_observation->>'frame_kind' IS DISTINCT FROM 'full_state'","coalesce(p_observation->>'frame_kind','') NOT IN ('full_state','partial_state')")
observe=observe.replace("OR jsonb_typeof(p_observation->'state'->'power') IS DISTINCT FROM 'boolean'","OR (p_observation->'state' ? 'power' AND jsonb_typeof(p_observation->'state'->'power') IS DISTINCT FROM 'boolean')")
observe=observe.replace("OR jsonb_typeof(p_observation->'state'->'temp') IS DISTINCT FROM 'number'","OR (p_observation->'state' ? 'temp' AND jsonb_typeof(p_observation->'state'->'temp') IS DISTINCT FROM 'number')")
observe=observe.replace("OR coalesce(p_observation->'state'->>'mode','') NOT IN ('cool','dry','fan','auto','heat')","OR (p_observation->'state' ? 'mode' AND coalesce(p_observation->'state'->>'mode','') NOT IN ('cool','dry','fan','auto','heat'))")
observe=observe.replace("OR coalesce(p_observation->'state'->>'fan','') NOT IN ('auto','low','medium','high','quiet','silent','turbo')","OR (p_observation->'state' ? 'fan' AND coalesce(p_observation->'state'->>'fan','') NOT IN ('auto','low','medium','high','max','quiet','silent','turbo'))")
observe=observe.replace(" IF (p_observation->'state'->>'temp')::numeric", """ IF NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_observation->'state') f WHERE f<>'source') THEN RAISE EXCEPTION 'No decoded fields'; END IF;
 IF p_observation ? 'remote_model' AND p_observation->'remote_model'<>'null'::jsonb AND (jsonb_typeof(p_observation->'remote_model')<>'number' OR (p_observation->>'remote_model') !~ '^[1-9][0-9]{0,4}$') THEN RAISE EXCEPTION 'Invalid decoded model'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_observation->'state') f WHERE f NOT IN ('source','power','temp','mode','fan','turbo','swing','eco','sleep','quiet','swing_vertical','swing_horizontal','display','filter','clean','beep','i_feel')) THEN RAISE EXCEPTION 'Unknown decoded field'; END IF;
 IF (p_observation->'state'->>'temp')::numeric""")
observe=observe.replace("ARRAY['turbo','swing','eco','sleep']","ARRAY['turbo','swing','eco','sleep','quiet','swing_vertical','swing_horizontal','display','filter','clean','beep','i_feel']")
observe=observe.replace(" UPDATE public.ecotrack_device_state SET latest_ir=latest", """ -- Carry known fields across partial frames, retaining the time each field was actually decoded.
 IF current_state.latest_ir->>'protocol'=p_observation->>'protocol' THEN
  latest:=jsonb_set(latest,ARRAY['state'],coalesce(current_state.latest_ir->'state','{}')||(p_observation->'state'));
 END IF;
 latest:=jsonb_set(latest,ARRAY['field_at'],coalesce(CASE WHEN current_state.latest_ir->>'protocol'=p_observation->>'protocol' THEN current_state.latest_ir->'field_at' END,'{}')||
   (SELECT jsonb_object_agg(f,coalesce(to_jsonb(to_timestamp((p_observation->>'captured_at_epoch_ms')::numeric/1000)),to_jsonb(seen))) FROM jsonb_object_keys(p_observation->'state') f WHERE f<>'source'));
 UPDATE public.ecotrack_device_state SET latest_ir=latest""")
sql=sql.replace('/* GENERATED_COMMAND_AND_OBSERVATION_FUNCTIONS */',request+'\n'+observe)
sqlpath=root/'supabase_ac_capabilities_migration.sql'
if '--check' in sys.argv:
    if not sqlpath.exists() or sqlpath.read_text(encoding='utf-8')!=sql:raise SystemExit('Generated SQL drift')
else:sqlpath.write_text(sql,encoding='utf-8')

firmware_template=(root/'config/ac-capabilities.firmware.source.h').read_text(encoding='utf-8')
firmware_data={key:data[key] for key in ['aliases','protocols']}
firmware_block=firmware_template.replace('/* AC_FIRMWARE_JSON */',json.dumps(firmware_data,separators=(',',':')))
sketchpath=root/'reports/cloud-hardware/EcoTrackCloudReceiver.ino.txt'
sketch=sketchpath.read_text(encoding='utf-8')
if '// BEGIN GENERATED AC CAPABILITIES' in sketch:
    a=sketch.index('// BEGIN GENERATED AC CAPABILITIES');b=sketch.index('// END GENERATED AC CAPABILITIES',a)+len('// END GENERATED AC CAPABILITIES')+1
    output=sketch[:a]+firmware_block+sketch[b:]
else:
    marker='bool prepareAcState('
    a=sketch.index(marker);output=sketch[:a]+firmware_block+'\n'+sketch[a:]
if '--check' in sys.argv:
    if output!=sketch:raise SystemExit('Generated firmware registry drift')
else:sketchpath.write_text(output,encoding='utf-8',newline='\r\n')
