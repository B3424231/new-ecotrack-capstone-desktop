// Shared read-only client for the locally trained research-estimate model.
(function (root) {
  'use strict';
  const MODEL = 'hist_gradient_boosting';
  const FEATURES = ['setpoint_c', 'fan_command', 'operating_mode', 'eco', 'turbo', 'swing', 'quiet', 'horizontal_swing', 'display'];
  const FLAGS = ['eco', 'turbo', 'swing', 'quiet', 'horizontal_swing', 'display'];
  const LABELS = { eco: 'Eco', turbo: 'Turbo', swing: 'Vertical Swing', quiet: 'Quiet',
    horizontal_swing: 'Horizontal Swing', display: 'Display' };
  let featurePromise = null;

  function backendUrl() {
    return String(root.ECOTRACK_CONFIG?.backendUrl || root.electron?.env?.BACKEND_URL ||
      'http://127.0.0.1:5000').replace(/\/+$/, '');
  }

  async function read(path, options = {}) {
    const controller = new AbortController();
    let timer, onAbort;
    const cancelled = () => { const error = new Error('Prediction request cancelled'); error.name = 'AbortError'; return error; };
    if (options.signal?.aborted) throw cancelled();
    const deadline = new Promise((_resolve, reject) => {
      onAbort = () => { controller.abort(); reject(cancelled()); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        reject(new Error('The prediction service timed out. Restart the Python backend and retry.'));
        controller.abort();
      }, 15000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        let response;
        try { response = await root.fetch(backendUrl() + path, { ...options, signal: controller.signal }); }
        catch (error) {
          if (error.name === 'AbortError') throw error;
          throw new Error('Predictions unavailable. Start or restart the desktop backend.');
        }
        let data;
        try { data = await response.json(); }
        catch (_) { throw new Error('The prediction service returned an unreadable response.'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The prediction service returned an invalid response. Please retry.');
        if (!response.ok || data.error) throw new Error(data.error || 'The prediction service is unavailable.');
        if (data.model !== MODEL || data.output_unit !== 'kWh' || data.horizon_hours !== 1 ||
            data.training_data_type !== 'research_informed_estimates' || data.physical_accuracy_validated !== false ||
            data.input_scope !== 'controls_only') {
          throw new Error('This response does not match the controls-only Histogram Gradient Boosting model. Restart the Python backend.');
        }
        return data;
      })()]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  function features(reload = false) {
    if (reload) featurePromise = null;
    if (!featurePromise) {
      featurePromise = read('/api/prediction-features?model=' + MODEL).then(data => {
        if (data.n_features !== FEATURES.length || !Array.isArray(data.features) ||
            data.features.length !== FEATURES.length || data.features.some((name, index) => name !== FEATURES[index]) ||
            data.environment_source !== 'not_used' || !Array.isArray(data.environment_scenarios) || data.environment_scenarios.length) {
          throw new Error('The model does not expose the nine AC control inputs. Restart the Python backend.');
        }
        return data;
      }).catch(error => { featurePromise = null; throw error; });
    }
    return featurePromise;
  }

  function knownFlag(value, label) {
    if (value === true || value === 1 || ['on', 'true', '1'].includes(String(value).trim().toLowerCase())) return true;
    if (value === false || value === 0 || ['off', 'false', '0'].includes(String(value).trim().toLowerCase())) return false;
    throw new Error('Provide an explicit ON/OFF state for ' + label + '.');
  }

  function pick(state, names, label, normalize = value => String(value).trim().toLowerCase()) {
    const values = names.filter(name => state[name] !== null && state[name] !== undefined && state[name] !== '')
      .map(name => state[name]);
    if (!values.length) throw new Error(label + ' is not recorded.');
    if (values.some(value => normalize(value) !== normalize(values[0]))) {
      throw new Error('Conflicting recorded values for ' + label + '.');
    }
    return values[0];
  }

  function normalizeSettings(state, { allowMissingFlags = false } = {}) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('Complete AC control settings are required.');
    }
    for (const key of ['filter', 'sleep', 'clean', 'beep', 'i_feel']) {
      if (state[key] != null && knownFlag(state[key], key)) {
        throw new Error(key + ' is outside this reference model. Its energy effect cannot be estimated.');
      }
    }
    const rawTemperature = pick(state, ['setpoint_c', 'temp', 'temperature'], 'Temperature setpoint', Number);
    const setpoint = Number(rawTemperature);
    if (typeof rawTemperature === 'boolean' || !Number.isFinite(setpoint) ||
        !Number.isInteger(setpoint) || setpoint < 16 || setpoint > 30) {
      throw new Error('This reference model supports integer setpoints from 16 to 30°C.');
    }
    const fan = String(pick(state, ['fan_command', 'fan'], 'Fan command')).trim().toLowerCase();
    const mode = String(pick(state, ['operating_mode', 'mode'], 'Operating mode')).trim().toLowerCase();
    if (!['auto', 'low', 'medium', 'high', 'quiet'].includes(fan)) throw new Error('The fan command is outside this model.');
    if (!['auto', 'cool', 'heat', 'dry', 'fan'].includes(mode)) throw new Error('The operating mode is outside this model.');
    const settings = { setpoint_c: setpoint, fan_command: fan, operating_mode: mode };
    for (const key of FLAGS) {
      const aliases = key === 'swing' ? ['swing_vertical', 'swing']
        : key === 'horizontal_swing' ? ['swing_horizontal', 'horizontal_swing'] : [key];
      if (allowMissingFlags && aliases.every(name => state[name] == null || state[name] === '')) continue;
      settings[key] = knownFlag(pick(state, aliases, LABELS[key], value => knownFlag(value, LABELS[key])), LABELS[key]);
    }
    return settings;
  }

  async function predict(state, optionsOrLegacyScenario = {}, legacyOptions = {}) {
    // Accept the former scenario argument for callers being refreshed; it is never sent or used.
    const options = typeof optionsOrLegacyScenario === 'object' && optionsOrLegacyScenario !== null
      ? optionsOrLegacyScenario : legacyOptions;
    const settings = normalizeSettings(state);
    const data = await read('/api/predict-energy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: options.signal,
      body: JSON.stringify({ model: MODEL, settings })
    });
    validatePrediction(data);
    return data;
  }

  function normalizeRecordedSettings(state) {
    return normalizeSettings(state, { allowMissingFlags: true });
  }

  async function predictRecorded(state, options = {}) {
    const settings = normalizeRecordedSettings(state);
    const data = await read('/api/predict-recorded-energy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: options.signal,
      body: JSON.stringify({ model: MODEL, settings })
    });
    validatePrediction(data);
    return data;
  }

  function validatePrediction(data) {
    const range = data.reference_range_kwh;
    if (!Number.isFinite(data.kwh) || data.kwh < 0 || data.prediction_status !== 'research_estimate' ||
        data.prediction_basis !== 'control_settings_only' || data.environment_source !== 'not_used' ||
        !Number.isFinite(range?.min) || !Number.isFinite(range?.max) || range.min < 0 ||
        range.min > data.kwh || range.max < data.kwh ||
        data.reference_condition_count !== 0 ||
        !Number.isInteger(data.reference_variant_count) || data.reference_variant_count < 1) {
      throw new Error('The model did not return a usable prediction from AC control settings only.');
    }
  }

  root.EcoTrackEnergyPrediction = {
    MODEL, FEATURES, FLAGS, LABELS, backendUrl, features, normalizeSettings, predict, normalizeRecordedSettings, predictRecorded,
    metrics: () => read('/api/prediction-metrics?model=' + MODEL)
  };
})(typeof window === 'undefined' ? globalThis : window);
