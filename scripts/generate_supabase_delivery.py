from pathlib import Path
import re
import sys
root=Path(__file__).resolve().parent.parent
files=[
    'supabase_ir_realtime_migration.sql',
    'supabase_controller_registration_migration.sql',
    'supabase_controller_details_migration.sql',
    'supabase_aircon_names_migration.sql',
    'supabase_ac_capabilities_migration.sql',
]
header="""-- EcoTrack reviewed delivery: live IR, registration, saved deployment dates,
-- independent custom AC/controller names and protocol/model capabilities.
-- Run the complete file as the project owner in Supabase SQL Editor.
-- Pause ESP32/cloud writers and close the desktop app for this short migration.
-- Prerequisite: the existing EcoTrack schema and cloud hardware migration are installed.
-- Does not recreate devices, rotate credentials or remove valid commands.
-- Existing command-retention triggers and scheduled cleanup remain installed.
-- All five sections commit together. A failure rolls back this entire run.
-- NOWAIT stops immediately if a required table is busy; retry the complete file.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
 IF to_regclass('public.ecotrack_device_state') IS NULL
    OR to_regclass('public.aircons') IS NULL
    OR to_regclass('public.nodes') IS NULL
    OR to_regprocedure('public.ecotrack_is_admin()') IS NULL THEN
  RAISE EXCEPTION 'Install the existing EcoTrack schema and supabase_cloud_hardware_migration.sql first';
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('ecotrack:multi-brand-delivery',0)) THEN
  RAISE EXCEPTION 'Another EcoTrack migration is running; retry after it finishes'
   USING ERRCODE='55P03';
 END IF;
 -- Acquire the strongest required locks before any DDL. Never wait while
 -- holding one table and requesting another table used by a live device RPC.
 BEGIN
  LOCK TABLE public.aircons, public.ecotrack_device_state, public.nodes
   IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF to_regclass('realtime.messages') IS NOT NULL
     AND to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL
     AND to_regprocedure('realtime.topic()') IS NOT NULL THEN
   LOCK TABLE realtime.messages IN ACCESS EXCLUSIVE MODE NOWAIT;
  END IF;
 EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'EcoTrack tables are busy; migration stopped before changing data'
   USING ERRCODE='55P03',
    HINT='Pause ESP32/cloud writers, close the desktop app, then run this complete file again.';
 END;
END $$;

"""
def section(file):
    source=(root/file).read_text(encoding='utf-8')
    # Source migrations remain independently usable. Only their outer transaction
    # statements are removed from this delivery; PL/pgSQL BEGIN blocks are retained.
    begins=list(re.finditer(r'^BEGIN;\s*$',source,re.MULTILINE))
    commits=list(re.finditer(r'^COMMIT;\s*$',source,re.MULTILINE))
    if len(begins)!=1 or len(commits)!=1:
        raise SystemExit('Expected one outer transaction in '+file)
    if begins[0].start()>commits[0].start():
        raise SystemExit('Invalid transaction order in '+file)
    source=re.sub(r'^(?:BEGIN|COMMIT);[ \t]*\r?\n?', '',source,flags=re.MULTILINE)
    return '-- Section: '+file+'\n'+source.rstrip()+'\n'
content=header+'\n'.join(section(file) for file in files)+'\nCOMMIT;\n'
target=root/'reports/multi-brand-capabilities/APPLY_SUPABASE.sql'
if '--check' in sys.argv:
    if not target.exists() or target.read_text(encoding='utf-8')!=content:
        raise SystemExit('Supabase delivery bundle drift')
else:
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(content,encoding='utf-8')
print('Supabase delivery bundle: '+str(len(files))+' sections, one atomic transaction with NOWAIT prelocks.')
