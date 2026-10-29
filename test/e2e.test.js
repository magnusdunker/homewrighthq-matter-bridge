// Runs the integration as HomewrightHQ does, as a child process on JSON-RPC,
// pairs a matter.js controller with the bridge, and checks that commands
// become service calls and states reach the controller.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { Environment, Logger } from '@matter/main';
import { ColorControl, FanControl, GeneralCommissioning, LevelControl, OnOff, Thermostat, WindowCovering } from '@matter/main/clusters';
import { ManualPairingCodeCodec } from '@matter/main/types';
import { CommissioningController } from '@project-chip/matter.js';

const PORT = 5600 + Math.floor(Math.random() * 300);
const ENTRY = { entry_id: 'e1', domain: 'matter_bridge', title: 'Hjem', data: {}, options: null };
const STATES = [
  { entity_id: 'light.stue', state: 'off', attributes: { friendly_name: 'Stue', supported_color_modes: ['color_temp'], brightness: 128, color_temp_kelvin: 3000, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 } },
  { entity_id: 'switch.kaffe', state: 'on', attributes: { friendly_name: 'Kaffemaskine' } },
  { entity_id: 'cover.kokken', state: 'open', attributes: { friendly_name: 'Køkkengardin', supported_features: 15, current_position: 100 } },
  { entity_id: 'climate.bad', state: 'heat', attributes: { friendly_name: 'Bad', hvac_modes: ['off', 'heat'], current_temperature: 21.5, temperature: 22, min_temp: 5, max_temp: 30 } },
  { entity_id: 'fan.loft', state: 'off', attributes: { friendly_name: 'Loftventilator', percentage: 0 } },
  { entity_id: 'sensor.ude', state: '4.5', attributes: { friendly_name: 'Ude', device_class: 'temperature', unit_of_measurement: '°C' } },
  { entity_id: 'binary_sensor.dor', state: 'on', attributes: { friendly_name: 'Hoveddør', device_class: 'door' } },
  { entity_id: 'sensor.watt', state: '12', attributes: { friendly_name: 'Effekt', device_class: 'power' } },
];

const dir = mkdtempSync(path.join(tmpdir(), 'matter-bridge-'));
let child;
let controller;
let nodeId;
const calls = [];
const sets = new Map();
let nextId = 1;
const pending = new Map();
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });

// HomewrightHQ's side of the protocol
function answer(method, p) {
  switch (method) {
    case 'state/all':
      return STATES.filter((s) => !p.domains || p.domains.includes(s.entity_id.split('.')[0]));
    case 'device/register':
      return { id: 'dev1', ...p.device };
    case 'entity/add':
      return { entity_id: 'sensor.matter_parring' };
    case 'state/set':
      sets.set(p.entity_id, p);
      return null;
    case 'hub/call_service':
      calls.push(p);
      return null;
    default:
      return null;
  }
}

async function waitFor(what, fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const callFor = (entity, service) => () => calls.find((c) => c.data?.entity_id === entity && c.service === service);

before(async () => {
  Logger.level = 'warn';
  // BRIDGE_BIN tests a compiled binary, as the release builds it
  const [cmd, args] = process.env.BRIDGE_BIN ? [process.env.BRIDGE_BIN, []] : [process.execPath, ['src/main.js']];
  child = spawn(cmd, args, { env: { ...process.env, HOMEWRIGHT_DATA_DIR: dir, MATTER_LOG_LEVEL: 'WARN' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.env.DEBUG_BRIDGE && process.stderr.write(d));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line); // anything that is not JSON on stdout fails the test
    if (m.method) {
      const result = answer(m.method, m.params ?? {});
      if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result });
    } else {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  });
  await request('initialize', { api_version: 1, domain: 'matter_bridge', data_dir: dir });
  const f = await request('config_flow', { flow: { source: 'user', data: {} }, step: 'user', input: null });
  assert.equal(f.result.type, 'form');
  const bad = await request('config_flow', { flow: { source: 'user', data: {} }, step: 'user', input: { name: 'Hjem', entities: [] } });
  assert.equal(bad.result.errors.entities, 'no_entities');
  const made = await request('config_flow', {
    flow: { source: 'user', data: {} },
    step: 'user',
    input: { name: 'Hjem', entities: STATES.map((s) => s.entity_id), port: PORT },
  });
  assert.equal(made.result.type, 'create_entry');
  ENTRY.data = made.result.data;
  await request('setup_entry', { entry: ENTRY });

  const pairing = sets.get('sensor.matter_parring');
  assert.equal(pairing.state, 'not_paired');
  const code = ManualPairingCodeCodec.decode(pairing.attributes.manual_code);

  const environment = Environment.default;
  environment.vars.set('storage.path', path.join(dir, 'controller'));
  controller = new CommissioningController({ environment: { environment, id: 'ctrl' }, autoConnect: false, adminFabricLabel: 'test' });
  await controller.start();
  nodeId = await controller.commissionNode({
    commissioning: { regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor, regulatoryCountryCode: 'XX' },
    discovery: { knownAddress: { ip: '127.0.0.1', port: PORT, type: 'udp' }, identifierData: { shortDiscriminator: code.shortDiscriminator } },
    passcode: code.passcode,
  });
});

after(async () => {
  await controller?.close().catch(() => {});
  child?.stdin.end();
  await new Promise((r) => (child ? child.on('exit', r) : r()));
  rmSync(dir, { recursive: true, force: true });
});

async function endpoints() {
  const node = await controller.getNode(nodeId);
  if (!node.isConnected) node.connect();
  if (!node.initialized) await node.events.initialized;
  const [aggregator] = node.getDevices();
  return aggregator.getChildEndpoints();
}

test('pairing is shown and the unsupported sensor is left out', async () => {
  await waitFor('paired state', () => sets.get('sensor.matter_parring')?.state === 'paired');
  const eps = await endpoints();
  assert.equal(eps.length, STATES.length - 1);
});

test('a controller turns the light on with a level and a colour temperature', async () => {
  const eps = await endpoints();
  const light = eps.find((e) => e.getClusterClient(ColorControl.Cluster.with('ColorTemperature')));
  await light.getClusterClient(LevelControl.Cluster).moveToLevelWithOnOff({ level: 254, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
  const c = await waitFor('light.turn_on', callFor('light.stue', 'turn_on'));
  assert.equal(c.domain, 'light');
  assert.equal(c.data.brightness, 255);
  calls.length = 0;
  await light.getClusterClient(ColorControl.Cluster.with('ColorTemperature')).moveToColorTemperature({ colorTemperatureMireds: 250, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
  const ct = await waitFor('colour temperature', callFor('light.stue', 'turn_on'));
  assert.equal(ct.data.color_temp_kelvin, 4000);
  calls.length = 0;
  await light.getClusterClient(OnOff.Cluster).off();
  await waitFor('light.turn_off', callFor('light.stue', 'turn_off'));
});

test('a switch, a cover, a fan and a thermostat take commands', async () => {
  const eps = await endpoints();
  calls.length = 0;
  const plug = eps.find((e) => e.getClusterClient(OnOff.Cluster) && !e.getClusterClient(LevelControl.Cluster));
  await plug.getClusterClient(OnOff.Cluster).off();
  await waitFor('switch.turn_off', callFor('switch.kaffe', 'turn_off'));

  const cover = eps.find((e) => e.getClusterClient(WindowCovering.Cluster));
  await cover.getClusterClient(WindowCovering.Cluster.with('Lift', 'PositionAwareLift')).goToLiftPercentage({ liftPercent100thsValue: 7000 });
  const pos = await waitFor('cover position', callFor('cover.kokken', 'set_cover_position'));
  assert.equal(pos.data.position, 30);
  await cover.getClusterClient(WindowCovering.Cluster).downOrClose();
  await waitFor('close_cover', callFor('cover.kokken', 'close_cover'));

  const fan = eps.find((e) => e.getClusterClient(FanControl.Cluster));
  await fan.getClusterClient(FanControl.Cluster).setPercentSettingAttribute(40);
  const f = await waitFor('fan percentage', callFor('fan.loft', 'set_percentage'));
  assert.equal(f.data.percentage, 40);

  const thermostat = eps.find((e) => e.getClusterClient(Thermostat.Cluster));
  await thermostat.getClusterClient(Thermostat.Cluster.with('Heating')).setOccupiedHeatingSetpointAttribute(2350);
  const t = await waitFor('set_temperature', callFor('climate.bad', 'set_temperature'));
  assert.equal(t.data.temperature, 23.5);
});

test('a state from HomewrightHQ reaches the controller', async () => {
  const eps = await endpoints();
  const light = eps.find((e) => e.getClusterClient(ColorControl.Cluster.with('ColorTemperature')));
  const onOff = light.getClusterClient(OnOff.Cluster);
  calls.length = 0;
  send({ jsonrpc: '2.0', method: 'state/changed', params: { entity_id: 'light.stue', new_state: { ...STATES[0], state: 'on', attributes: { ...STATES[0].attributes, brightness: 51 } } } });
  await waitFor('on at the controller', async () => (await onOff.getOnOffAttribute(true)) === true);
  assert.equal(await light.getClusterClient(LevelControl.Cluster).getCurrentLevelAttribute(true), 51);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.length, 0, 'a state from HomewrightHQ does not call back');
});
