import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endpointId, fanModeFor, fromLift, kindOf, label, lightCall, toLift, toMatter } from '../src/mapping.js';

const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes });

test('entities become the right kind of device', () => {
  assert.equal(kindOf(st('light.a', 'on', { supported_color_modes: ['onoff'] })).kind, 'onoff_light');
  assert.equal(kindOf(st('light.a', 'on', { supported_color_modes: ['brightness'] })).kind, 'dimmable_light');
  assert.deepEqual(kindOf(st('light.a', 'on', { supported_color_modes: ['color_temp'] })), { kind: 'ct_light', ct: true });
  assert.deepEqual(kindOf(st('light.a', 'on', { supported_color_modes: ['hs', 'color_temp'] })), { kind: 'color_light', ct: true });
  assert.equal(kindOf(st('input_boolean.a', 'on')).kind, 'plug');
  assert.deepEqual(kindOf(st('cover.a', 'open', { supported_features: 3 })), { kind: 'cover', position: false });
  assert.deepEqual(kindOf(st('climate.a', 'heat', { hvac_modes: ['off', 'heat', 'cool'] })), { kind: 'thermostat', cooling: true });
  assert.equal(kindOf(st('sensor.a', '1', { device_class: 'humidity' })).kind, 'humidity');
  assert.equal(kindOf(st('sensor.a', '1', { device_class: 'power' })), null);
  assert.equal(kindOf(st('binary_sensor.a', 'on', { device_class: 'window' })).kind, 'contact');
  assert.equal(kindOf(st('binary_sensor.a', 'on', { device_class: 'presence' })).kind, 'occupancy');
  assert.equal(kindOf(st('binary_sensor.a', 'on', { device_class: 'smoke' })), null);
  assert.equal(kindOf(st('lock.a', 'locked')), null);
});

test('names and endpoint ids fit Matter', () => {
  assert.equal(label(st('light.a', 'on', { friendly_name: 'En meget lang lampe i stuen ved vinduet mod haven' })).length, 32);
  assert.equal(label(st('light.a', 'on')), 'light.a');
  assert.equal(endpointId('light.stue_loft'), 'e_light_stue_loft');
});

test('states become Matter attributes', () => {
  const light = toMatter({ kind: 'ct_light', ct: true }, st('light.a', 'on', { brightness: 255, color_temp_kelvin: 2700 }));
  assert.deepEqual(light, { onOff: { onOff: true }, levelControl: { currentLevel: 254 }, colorControl: { colorTemperatureMireds: 370 } });
  assert.deepEqual(toMatter({ kind: 'ct_light', ct: true }, st('light.a', 'off', {})), { onOff: { onOff: false } });
  const hs = toMatter({ kind: 'color_light', ct: false }, st('light.a', 'on', { hs_color: [180, 50] }));
  assert.deepEqual(hs.colorControl, { currentHue: 127, currentSaturation: 127 });
  // a door that is open has no contact
  assert.equal(toMatter({ kind: 'contact' }, st('binary_sensor.d', 'on')).booleanState.stateValue, false);
  assert.equal(toMatter({ kind: 'temperature' }, st('sensor.t', '21.5', { unit_of_measurement: '°C' })).temperatureMeasurement.measuredValue, 2150);
  assert.equal(toMatter({ kind: 'temperature' }, st('sensor.t', '50', { unit_of_measurement: '°F' })).temperatureMeasurement.measuredValue, 1000);
  assert.equal(toMatter({ kind: 'temperature' }, st('sensor.t', 'unknown')).temperatureMeasurement.measuredValue, null);
  assert.equal(toMatter({ kind: 'illuminance' }, st('sensor.l', '100')).illuminanceMeasurement.measuredValue, 20001);
  const t = toMatter({ kind: 'thermostat', cooling: false }, st('climate.b', 'heat', { current_temperature: 20, temperature: 40, max_temp: 30 }));
  assert.deepEqual(t.thermostat, { localTemperature: 2000, occupiedHeatingSetpoint: 3000, systemMode: 4 });
  assert.equal(toMatter({ kind: 'thermostat', cooling: false }, st('climate.b', 'off', {})).thermostat.systemMode, 0);
  assert.deepEqual(toMatter({ kind: 'fan' }, st('fan.f', 'on', { percentage: 50 })).fanControl, { percentSetting: 50, percentCurrent: 50, fanMode: 2 });
  assert.equal(toMatter({ kind: 'fan' }, st('fan.f', 'off', { percentage: 50 })).fanControl.percentSetting, 0);
});

test('cover positions turn around', () => {
  assert.equal(toLift(100), 0);
  assert.equal(toLift(0), 10000);
  assert.equal(fromLift(7000), 30);
  const closed = toMatter({ kind: 'cover', position: false }, st('cover.c', 'closed'));
  assert.equal(closed.windowCovering.currentPositionLiftPercent100ths, 10000);
});

test("a controller's light changes become one call", () => {
  assert.deepEqual(lightCall({ on: false, level: 100 }), { service: 'turn_off', data: {} });
  assert.deepEqual(lightCall({ on: true, level: 254 }), { service: 'turn_on', data: { brightness: 255 } });
  assert.deepEqual(lightCall({ mireds: 250 }), { service: 'turn_on', data: { color_temp_kelvin: 4000 } });
  assert.deepEqual(lightCall({ hue: 127, sat: 254 }), { service: 'turn_on', data: { hs_color: [180, 100] } });
  assert.equal(fanModeFor(10), 1);
  assert.equal(fanModeFor(100), 3);
});
