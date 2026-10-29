// Pure conversions between HomewrightHQ states and Matter attributes, and
// from Matter changes to HomewrightHQ service calls. No matter.js here, so it
// is easy to test.

/** The domains the bridge can show. */
export const DOMAINS = ['light', 'switch', 'input_boolean', 'fan', 'cover', 'climate', 'sensor', 'binary_sensor'];

const COLOR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];
const CONTACT_CLASSES = ['door', 'window', 'opening', 'garage_door'];
const OCCUPANCY_CLASSES = ['motion', 'occupancy', 'presence'];
// cover.supported_features
const COVER_SET_POSITION = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * What kind of Matter device an entity becomes, or null when the bridge
 * cannot show it.
 * @returns {{ kind: string, ct?: boolean, cooling?: boolean, position?: boolean } | null}
 */
export function kindOf(state) {
  if (!state?.entity_id) return null;
  const domain = state.entity_id.split('.')[0];
  const a = state.attributes ?? {};
  switch (domain) {
    case 'light': {
      const modes = Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [];
      const ct = modes.includes('color_temp');
      if (modes.some((m) => COLOR_MODES.includes(m))) return { kind: 'color_light', ct };
      if (ct) return { kind: 'ct_light', ct };
      if (modes.includes('brightness') || modes.includes('white')) return { kind: 'dimmable_light' };
      return { kind: 'onoff_light' };
    }
    case 'switch':
    case 'input_boolean':
      return { kind: 'plug' };
    case 'fan':
      return { kind: 'fan' };
    case 'cover':
      return { kind: 'cover', position: ((a.supported_features ?? 0) & COVER_SET_POSITION) !== 0 };
    case 'climate': {
      const modes = Array.isArray(a.hvac_modes) ? a.hvac_modes : [];
      return { kind: 'thermostat', cooling: modes.includes('cool') };
    }
    case 'sensor':
      if (a.device_class === 'temperature') return { kind: 'temperature' };
      if (a.device_class === 'humidity') return { kind: 'humidity' };
      if (a.device_class === 'illuminance') return { kind: 'illuminance' };
      return null;
    case 'binary_sensor':
      if (CONTACT_CLASSES.includes(a.device_class)) return { kind: 'contact' };
      if (OCCUPANCY_CLASSES.includes(a.device_class)) return { kind: 'occupancy' };
      if (a.device_class === 'moisture') return { kind: 'leak' };
      return null;
    default:
      return null;
  }
}

/** Whether the entity's state means the device answers. */
export function reachable(state) {
  return !!state && state.state !== 'unavailable';
}

/** The name Matter shows: at most 32 characters. */
export function label(state) {
  const name = String(state?.attributes?.friendly_name ?? state?.entity_id ?? '').trim();
  return [...name].slice(0, 32).join('') || 'HomewrightHQ';
}

/** A Matter endpoint id for an entity: letters, digits and `_`. */
export function endpointId(entityId) {
  return 'e_' + entityId.replace(/[^a-zA-Z0-9]/g, '_');
}

// HomewrightHQ brightness is 0-255, Matter's level 1-254.
export const toLevel = (brightness) => clamp(Math.round((brightness * 254) / 255), 1, 254);
export const fromLevel = (level) => clamp(Math.round((level * 255) / 254), 1, 255);
export const toMireds = (kelvin) => clamp(Math.round(1_000_000 / kelvin), 1, 65279);
export const fromMireds = (mireds) => Math.round(1_000_000 / Math.max(1, mireds));
// hue 0-360 and saturation 0-100 against Matter's 0-254
export const toHue = (h) => clamp(Math.round((h * 254) / 360), 0, 254);
export const toSat = (s) => clamp(Math.round((s * 254) / 100), 0, 254);
export const fromHue = (h) => Math.round(((h * 360) / 254) * 10) / 10;
export const fromSat = (s) => Math.round(((s * 100) / 254) * 10) / 10;
// cover position 0 (closed)-100 (open) against Matter's 0 (open)-10000 (closed)
export const toLift = (position) => clamp(Math.round((100 - position) * 100), 0, 10000);
export const fromLift = (percent100ths) => clamp(Math.round(100 - percent100ths / 100), 0, 100);
// illuminance in lx against Matter's 10000 * log10(lx) + 1
export const toLux = (lx) => (lx <= 0 ? 0 : clamp(Math.round(10000 * Math.log10(lx) + 1), 1, 0xfffe));

const celsius = (state, v) => {
  const n = num(v);
  if (n === null) return null;
  const unit = state.attributes?.unit_of_measurement ?? state.attributes?.temperature_unit;
  return unit === '°F' ? ((n - 32) * 5) / 9 : n;
};
const centi = (v) => (v === null ? null : Math.round(v * 100));

/** Thermostat limits in 1/100 °C. */
export function thermostatLimits(state) {
  const a = state.attributes ?? {};
  const min = centi(celsius(state, a.min_temp)) ?? 700;
  const max = centi(celsius(state, a.max_temp)) ?? 3500;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** Matter's `systemMode` for an `hvac_mode`. */
export function systemMode(hvac, cooling) {
  switch (hvac) {
    case 'off':
      return 0;
    case 'cool':
      return cooling ? 3 : 0;
    case 'heat':
    default:
      return 4;
  }
}

/**
 * The cluster states for an endpoint, for `endpoint.set()`. Values that the
 * entity does not have are left out, so the endpoint keeps what it had.
 */
export function toMatter(kind, state) {
  const a = state.attributes ?? {};
  const on = state.state === 'on';
  switch (kind.kind) {
    case 'onoff_light':
    case 'plug':
      return { onOff: { onOff: on } };
    case 'dimmable_light':
    case 'ct_light':
    case 'color_light': {
      const out = { onOff: { onOff: on } };
      const b = num(a.brightness);
      if (on && b !== null) out.levelControl = { currentLevel: toLevel(b) };
      const cc = {};
      const k = num(a.color_temp_kelvin);
      if (kind.ct && k !== null && k > 0) cc.colorTemperatureMireds = toMireds(k);
      if (kind.kind === 'color_light' && Array.isArray(a.hs_color) && a.hs_color.length === 2) {
        cc.currentHue = toHue(Number(a.hs_color[0]));
        cc.currentSaturation = toSat(Number(a.hs_color[1]));
      }
      if (kind.kind === 'color_light' && Array.isArray(a.xy_color) && a.xy_color.length === 2) {
        cc.currentX = clamp(Math.round(Number(a.xy_color[0]) * 65536), 0, 65279);
        cc.currentY = clamp(Math.round(Number(a.xy_color[1]) * 65536), 0, 65279);
      }
      if (Object.keys(cc).length) out.colorControl = cc;
      return out;
    }
    case 'fan': {
      const p = num(a.percentage);
      const percent = on ? clamp(Math.round(p ?? 100), 1, 100) : 0;
      return { fanControl: { percentSetting: percent, percentCurrent: percent, fanMode: on ? fanModeFor(percent) : 0 } };
    }
    case 'cover': {
      const p = num(a.current_position);
      const position = kind.position && p !== null ? p : state.state === 'closed' ? 0 : 100;
      const lift = toLift(position);
      return { windowCovering: { currentPositionLiftPercent100ths: lift, targetPositionLiftPercent100ths: lift } };
    }
    case 'thermostat': {
      const t = {};
      const cur = centi(celsius(state, a.current_temperature));
      if (cur !== null) t.localTemperature = cur;
      const { min, max } = thermostatLimits(state);
      const sp = centi(celsius(state, a.temperature));
      if (sp !== null) {
        t.occupiedHeatingSetpoint = clamp(sp, min, max);
        if (kind.cooling) t.occupiedCoolingSetpoint = clamp(sp, min, max);
      }
      t.systemMode = systemMode(state.state, kind.cooling);
      return { thermostat: t };
    }
    case 'temperature': {
      const v = centi(celsius(state, state.state));
      return { temperatureMeasurement: { measuredValue: v === null ? null : clamp(v, -27315, 32767) } };
    }
    case 'humidity': {
      const v = num(state.state);
      return { relativeHumidityMeasurement: { measuredValue: v === null ? null : clamp(Math.round(v * 100), 0, 10000) } };
    }
    case 'illuminance': {
      const v = num(state.state);
      return { illuminanceMeasurement: { measuredValue: v === null ? null : toLux(v) } };
    }
    case 'contact':
      // Matter: true is closed (contact)
      return { booleanState: { stateValue: state.state === 'off' } };
    case 'leak':
      return { booleanState: { stateValue: on } };
    case 'occupancy':
      return { occupancySensing: { occupancy: { occupied: on } } };
    default:
      return {};
  }
}

/** Matter's fan mode (1 low, 2 medium, 3 high) for a percentage. */
export function fanModeFor(percent) {
  if (percent <= 0) return 0;
  if (percent <= 33) return 1;
  if (percent <= 66) return 2;
  return 3;
}

/**
 * The service call for the changes a controller made to a light, collected
 * over a short moment: `{ on, level, mireds, hue, sat, x, y }`.
 * @returns {{ service: string, data: object }}
 */
export function lightCall(changes) {
  if (changes.on === false) return { service: 'turn_off', data: {} };
  const data = {};
  if (changes.level !== undefined) data.brightness = fromLevel(changes.level);
  if (changes.mireds !== undefined) data.color_temp_kelvin = fromMireds(changes.mireds);
  else if (changes.hue !== undefined || changes.sat !== undefined) data.hs_color = [fromHue(changes.hue ?? 0), fromSat(changes.sat ?? 0)];
  else if (changes.x !== undefined && changes.y !== undefined) data.xy_color = [Math.round((changes.x / 65536) * 10000) / 10000, Math.round((changes.y / 65536) * 10000) / 10000];
  return { service: 'turn_on', data };
}
