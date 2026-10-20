from pathlib import Path
import json,re
base=Path('C:/Users/reygay/Documents/Arduino/libraries/IRremoteESP8266/src')
pairs={'TCL112AC':('Tcl','IRTcl112Ac'),'TEKNOPOINT':('Tcl','IRTcl112Ac'),'DAIKIN':('Daikin','IRDaikinESP'),'DAIKIN2':('Daikin','IRDaikin2'),'DAIKIN64':('Daikin','IRDaikin64'),'DAIKIN216':('Daikin','IRDaikin216'),'GREE':('Gree','IRGreeAC'),'MIDEA':('Midea','IRMideaAC'),'PANASONIC_AC':('Panasonic','IRPanasonicAc'),'SAMSUNG_AC':('Samsung','IRSamsungAc'),'MITSUBISHI_AC':('Mitsubishi','IRMitsubishiAC'),'CARRIER_AC64':('Carrier','IRCarrierAc64'),'FUJITSU_AC':('Fujitsu','IRFujitsuAC'),'HAIER_AC':('Haier','IRHaierAC'),'TOSHIBA_AC':('Toshiba','IRToshibaAC'),'SHARP_AC':('Sharp','IRSharpAc'),'HITACHI_AC':('Hitachi','IRHitachiAc'),'WHIRLPOOL_AC':('Whirlpool','IRWhirlpoolAc')}
mapping={'power':'power','degrees':'temp','mode':'mode','fanspeed':'fan','turbo':'turbo','quiet':'quiet','econo':'eco','light':'display','filter':'filter','clean':'clean','beep':'beep','sleep':'sleep','swingv':'swing_vertical','swingh':'swing_horizontal','iFeel':'i_feel'}
data=json.loads(Path('config/ac-capabilities.json').read_text(encoding='utf-8'))
evidence={}
for protocol,(file,cls) in pairs.items():
 source=(base/('ir_'+file+'.cpp')).read_text(encoding='utf-8')
 match=re.search(r'stdAc::state_t '+cls+r'::toCommon\([\s\S]*?\n}',source)
 if not match:raise RuntimeError('Missing decoder audit '+cls)
 body=match[0]
 fields=[]
 for native,feature in mapping.items():
  assignments=re.findall(r'result\.'+native+r'\s*=([^;]+);',body)
  known=any(not re.fullmatch(r'\s*(?:false|true|0|-1|-1\.0|stdAc::[\w:]+)\s*',value) for value in assignments)
  if known:fields.append(feature)
 if protocol in ['TCL112AC','TEKNOPOINT'] and 'quiet' in fields:fields.remove('quiet') # Normal frames retain Quiet from a previous Type-2 message; it is not fresh.
 data['protocols'][protocol]['decode_fields']=fields
 evidence[protocol]={'class':cls,'fields':fields,'source':body}
Path('config/ac-capabilities.json').write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
Path('reports/multi-brand-capabilities/decoder-audit.json').write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf-8')
print('Audited decoder fields for '+str(len(evidence))+' profiles.')
