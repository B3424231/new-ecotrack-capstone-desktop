// BEGIN GENERATED AC CAPABILITIES
const char AC_CAPABILITY_JSON[] PROGMEM = R"ACREG(/* AC_FIRMWARE_JSON */)ACREG";
JsonDocument acRegistry;
bool acRegistryReady=false;
void ensureAcRegistry() {
  if(!acRegistryReady)acRegistryReady=!deserializeJson(acRegistry,AC_CAPABILITY_JSON);
}
void mergeAcCaps(JsonObject target,JsonObjectConst change) {
  for(JsonPairConst item:change){
    if(item.value().is<JsonObjectConst>() && target[item.key()].is<JsonObject>())mergeAcCaps(target[item.key()].as<JsonObject>(),item.value().as<JsonObjectConst>());
    else target[item.key()].set(item.value());
  }
}
void resolveAcProfile(const String &protocol,int16_t model,JsonDocument &profile) {
  ensureAcRegistry();profile.set(acRegistry["protocols"][protocol].as<JsonVariantConst>());
  JsonObjectConst change=profile["model_rules"][String(model)].as<JsonObjectConst>();
  if(!change.isNull()){
    JsonDocument copy;copy.set(change);mergeAcCaps(profile.as<JsonObject>(),copy.as<JsonObjectConst>());
  }
}
bool acProfileReady(JsonVariantConst profile,int16_t model) {
  return !profile.isNull() && (!(profile["requires_model"]|false) || !profile["models"][String(model)].isNull());
}
String profileFan(const stdAc::state_t &state) {
  JsonDocument profile;resolveAcProfile(typeToString(state.protocol),state.model,profile);
  String code=String((int)state.fanspeed);
  if(profile["fan_decode_aliases"][code].is<const char *>())return profile["fan_decode_aliases"][code].as<String>();
  for(JsonPairConst item:profile["fan_map"].as<JsonObjectConst>())if(item.value().as<int>()==(int)state.fanspeed)return String(item.key().c_str());
  return ""; // A native value without an audited mapping is not fabricated.
}
bool validateAcProfile(JsonVariantConst payload,decode_type_t type,int16_t model,String &error) {
  JsonDocument profile;resolveAcProfile(typeToString(type),model,profile);
  if(!acProfileReady(profile.as<JsonVariantConst>(),model)){error="Choose an audited exact AC protocol and remote model.";return false;}
  JsonVariantConst state=payload["state"];String mode=state["mode"]|"",fan=state["fan"]|"";
  bool allowed=false;for(JsonVariantConst item:profile["modes"].as<JsonArrayConst>())if(item.as<String>()==mode)allowed=true;
  if(!allowed || profile["fan_map"][fan].isNull()){error="Operating mode or fan is unavailable for this model.";return false;}
  JsonVariantConst rule=profile["mode_rules"][mode],range=profile["temperature"];
  float lo=range["min"]|NAN,hi=range["max"]|NAN,step=range["step"]|NAN,temp=state["temp"].as<float>();
  if(!rule["min"].isNull())lo=fmaxf(lo,rule["min"].as<float>());
  if(!rule["max"].isNull())hi=fminf(hi,rule["max"].as<float>());
  if(!rule["fixed_temp"].isNull())lo=hi=rule["fixed_temp"].as<float>();
  if(!(profile["features"]["temperature"]|false) || !isfinite(temp) || !isfinite(lo) || !isfinite(hi) || !isfinite(step) || step<=0 ||
     temp<lo || temp>hi || fabsf((temp-lo)/step-roundf((temp-lo)/step))>0.001f){error="Temperature is outside this protocol/model range or step.";return false;}
  if(!rule["fixed_fan"].isNull() && fan!=rule["fixed_fan"].as<String>()){error="This mode requires its protocol-specific fan speed.";return false;}
  JsonVariantConst limits=payload["capability_constraints"];
  if(!limits.isNull()){
    if(String(limits["protocol"]|"")!=typeToString(type) || (!limits["model"].isNull() && limits["model"].as<int>()!=model) ||
       !limits["min"].is<float>() || !limits["max"].is<float>() || !limits["step"].is<float>()){
      error="Invalid cloud capability constraints.";return false;
    }
    float a=limits["min"],b=limits["max"],d=limits["step"];
    if(a<lo || b>hi || d<step || temp<a || temp>b || d<=0 || fabsf((temp-a)/d-roundf((temp-a)/d))>0.001f){
      error="Temperature does not match the admin-verified range and steps.";return false;
    }
  }
  for(JsonPairConst item:state.as<JsonObjectConst>()){
    String key=item.key().c_str();if(key=="power"||key=="mode"||key=="temp"||key=="fan")continue;
    String feature=key=="swing"?"swing_vertical":key;
    bool value;if(profile["features"][feature].isNull() || !switchValue(item.value(),value) || (value && !(profile["features"][feature]|false))){
      error="Unsupported AC feature: "+key;return false;
    }
  }
  return true;
}
// END GENERATED AC CAPABILITIES
