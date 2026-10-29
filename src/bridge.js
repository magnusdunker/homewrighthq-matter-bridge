// The Matter side: one matter.js server node with an aggregator, and a bridged
// endpoint per entity. A controller's changes become HomewrightHQ service
// calls; HomewrightHQ's states are written to the endpoints.

import { Endpoint, Environment, ServerNode, VendorId } from '@matter/main';
import { QrCode } from '@matter/main/types';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import { ColorControlServer } from '@matter/main/behaviors/color-control';
import { FanControlServer } from '@matter/main/behaviors/fan-control';
import { OccupancySensingServer } from '@matter/main/behaviors/occupancy-sensing';
import { ThermostatServer } from '@matter/main/behaviors/thermostat';
import { WindowCoveringServer } from '@matter/main/behaviors/window-covering';
import { ColorTemperatureLightDevice } from '@matter/main/devices/color-temperature-light';
import { ContactSensorDevice } from '@matter/main/devices/contact-sensor';
import { DimmableLightDevice } from '@matter/main/devices/dimmable-light';
import { ExtendedColorLightDevice } from '@matter/main/devices/extended-color-light';
import { FanDevice } from '@matter/main/devices/fan';
import { HumiditySensorDevice } from '@matter/main/devices/humidity-sensor';
import { LightSensorDevice } from '@matter/main/devices/light-sensor';
import { OccupancySensorDevice } from '@matter/main/devices/occupancy-sensor';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { OnOffPlugInUnitDevice } from '@matter/main/devices/on-off-plug-in-unit';
import { TemperatureSensorDevice } from '@matter/main/devices/temperature-sensor';
import { ThermostatDevice } from '@matter/main/devices/thermostat';
import { WaterLeakDetectorDevice } from '@matter/main/devices/water-leak-detector';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import '@matter/nodejs';
import { createHash } from 'node:crypto';

import { endpointId, fromLift, kindOf, label, lightCall, reachable, thermostatLimits, toMatter } from './mapping.js';

// matter.js uses the test vendor id: the bridge is not certified
const VENDOR_ID = 0xfff1;
const PRODUCT_ID = 0x8000;
/** How long a controller's changes to one entity are collected before the call. */
const SETTLE_MS = 120;

/** Endpoint id → the bridge and entity, for the behaviors below. */
const owners = new Map();

class BridgeCovering extends WindowCoveringServer.with('Lift', 'PositionAwareLift') {
  handleMovement(_type, _reversed, direction, targetPercent100ths) {
    const o = owners.get(this.endpoint.id);
    if (!o) return;
    // fully open or closed (up/down, or a position at the end) use open and close
    const target = targetPercent100ths ?? (direction === 1 ? 10000 : 0);
    if (target === 0 || target === 10000 || !o.kind.position) {
      o.bridge.call(o.entityId, 'cover', target >= 5000 ? 'close_cover' : 'open_cover', {});
      return;
    }
    o.bridge.call(o.entityId, 'cover', 'set_cover_position', { position: fromLift(target) });
  }

  handleStopMovement() {
    const o = owners.get(this.endpoint.id);
    if (o) o.bridge.call(o.entityId, 'cover', 'stop_cover', {});
  }
}

/** The endpoint type and its starting state for an entity. */
function endpointType(kind, state) {
  const info = BridgedDeviceBasicInformationServer;
  switch (kind.kind) {
    case 'onoff_light':
      return OnOffLightDevice.with(info);
    case 'dimmable_light':
      return DimmableLightDevice.with(info);
    case 'ct_light':
      return ColorTemperatureLightDevice.with(info, ColorControlServer.with('ColorTemperature'));
    case 'color_light':
      return ExtendedColorLightDevice.with(info, ColorControlServer.with('Xy', 'HueSaturation', 'ColorTemperature'));
    case 'plug':
      return OnOffPlugInUnitDevice.with(info);
    case 'fan':
      return FanDevice.with(info, FanControlServer);
    case 'cover':
      return WindowCoveringDevice.with(info, BridgeCovering);
    case 'thermostat':
      return ThermostatDevice.with(info, kind.cooling ? ThermostatServer.with('Heating', 'Cooling') : ThermostatServer.with('Heating'));
    case 'temperature':
      return TemperatureSensorDevice.with(info);
    case 'humidity':
      return HumiditySensorDevice.with(info);
    case 'illuminance':
      return LightSensorDevice.with(info);
    case 'contact':
      return ContactSensorDevice.with(info);
    case 'occupancy':
      return OccupancySensorDevice.with(info, OccupancySensingServer.with('PassiveInfrared'));
    case 'leak':
      return WaterLeakDetectorDevice.with(info);
    default:
      throw new Error(`unknown kind ${kind.kind} for ${state.entity_id}`);
  }
}

/** The state an endpoint needs before it starts, besides what `toMatter` gives. */
function initialState(kind, state) {
  const out = {};
  const a = state.attributes ?? {};
  if (kind.ct || kind.kind === 'color_light') {
    const minK = Number(a.min_color_temp_kelvin) || 2000;
    const maxK = Number(a.max_color_temp_kelvin) || 6500;
    const minM = Math.round(1_000_000 / maxK);
    const maxM = Math.round(1_000_000 / minK);
    out.colorControl = {
      colorTempPhysicalMinMireds: minM,
      colorTempPhysicalMaxMireds: maxM,
      coupleColorTempToLevelMinMireds: minM,
      colorTemperatureMireds: Math.round((minM + maxM) / 2),
      startUpColorTemperatureMireds: null,
      // 2 is colour temperature; a colour light starts in hue and saturation
      ...(kind.kind === 'ct_light' ? { colorMode: 2, enhancedColorMode: 2 } : {}),
    };
  }
  if (kind.kind === 'fan') out.fanControl = { fanModeSequence: 0 };
  if (kind.kind === 'thermostat') {
    const { min, max } = thermostatLimits(state);
    out.thermostat = {
      controlSequenceOfOperation: kind.cooling ? 4 : 2,
      absMinHeatSetpointLimit: min,
      absMaxHeatSetpointLimit: max,
      minHeatSetpointLimit: min,
      maxHeatSetpointLimit: max,
      occupiedHeatingSetpoint: Math.max(min, Math.min(max, 2000)),
      ...(kind.cooling ? { absMinCoolSetpointLimit: min, absMaxCoolSetpointLimit: max, minCoolSetpointLimit: min, maxCoolSetpointLimit: max, occupiedCoolingSetpoint: Math.max(min, Math.min(max, 2400)) } : {}),
    };
  }
  if (kind.kind === 'occupancy') out.occupancySensing = { occupancySensorType: 0, occupancySensorTypeBitmap: { pir: true } };
  return out;
}

/** A stable id for an entity's bridged device, different from its serial number. */
function uniqueId(serial, entityId) {
  return createHash('sha256').update(`${serial}/${entityId}`).digest('hex').slice(0, 32);
}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
}

export class Bridge {
  /**
   * @param {object} o
   * @param {string} o.storagePath folder for the node's keys and fabrics
   * @param {number} o.port UDP port for Matter
   * @param {string} o.name the bridge's name in the controller's app
   * @param {string} o.serial a stable serial number for this installation
   * @param {(domain: string, service: string, data: object) => Promise<any>} o.callService
   * @param {() => void} [o.onPairingChanged]
   */
  constructor(o) {
    this.o = o;
    /** entity id → { endpoint, kind, entityId } */
    this.entities = new Map();
    /** entity id → { timer, changes } for a controller's changes being collected */
    this.pending = new Map();
    this.server = null;
  }

  /** Start the node with an endpoint per entity the bridge can show. Returns those it skipped. */
  async start(states) {
    const env = Environment.default;
    env.vars.set('storage.path', this.o.storagePath);
    const name = [...this.o.name].slice(0, 32).join('');
    this.server = await ServerNode.create({
      id: 'bridge',
      network: { port: this.o.port },
      productDescription: { name, deviceType: AggregatorEndpoint.deviceType },
      basicInformation: {
        vendorName: 'HomewrightHQ',
        vendorId: VendorId(VENDOR_ID),
        nodeLabel: name,
        productName: 'HomewrightHQ Matter bridge',
        productLabel: 'HomewrightHQ',
        productId: PRODUCT_ID,
        serialNumber: this.o.serial,
        uniqueId: uniqueId(this.o.serial, 'bridge'),
      },
    });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await this.server.add(aggregator);

    const skipped = [];
    for (const state of states) {
      const kind = kindOf(state);
      if (!kind) {
        skipped.push(state.entity_id);
        continue;
      }
      const id = endpointId(state.entity_id);
      owners.set(id, { bridge: this, entityId: state.entity_id, kind });
      const type = endpointType(kind, state);
      const endpoint = new Endpoint(type, {
        id,
        bridgedDeviceBasicInformation: {
          nodeLabel: label(state),
          productName: label(state),
          productLabel: label(state),
          serialNumber: state.entity_id.slice(0, 32),
          uniqueId: uniqueId(this.o.serial, state.entity_id),
          reachable: reachable(state),
        },
        ...merge(initialState(kind, state), reachable(state) ? toMatter(kind, state) : {}),
      });
      try {
        await aggregator.add(endpoint);
      } catch (e) {
        process.stderr.write(`WARN ${state.entity_id} could not be added: ${e?.message ?? e}\n`);
        owners.delete(id);
        skipped.push(state.entity_id);
        continue;
      }
      this.entities.set(state.entity_id, { endpoint, kind, entityId: state.entity_id });
      this.#listen(endpoint, kind, state.entity_id);
    }

    const changed = () => this.o.onPairingChanged?.();
    this.server.lifecycle.commissioned.on(changed);
    this.server.lifecycle.decommissioned.on(changed);
    this.server.events.commissioning.fabricsChanged.on(changed);
    await this.server.start();
    return skipped;
  }

  /** Write an entity's new state to its endpoint. */
  async update(entityId, state) {
    const e = this.entities.get(entityId);
    if (!e || !this.server) return;
    const values = { bridgedDeviceBasicInformation: { reachable: reachable(state) } };
    try {
      await e.endpoint.set(reachable(state) ? merge(values, toMatter(e.kind, state)) : values);
    } catch (err) {
      process.stderr.write(`WARN ${entityId}: ${err?.message ?? err}\n`);
    }
  }

  /** Pairing codes, whether a controller has paired, and with which. */
  pairing() {
    const c = this.server?.state.commissioning;
    if (!c) return null;
    const fabrics = Object.values(c.fabrics ?? {}).map((f) => ({ label: f.label || null, vendor_id: Number(f.rootVendorId) }));
    return {
      commissioned: !!c.commissioned,
      manual_code: c.pairingCodes.manualPairingCode,
      qr_code: c.pairingCodes.qrPairingCode,
      fabrics,
    };
  }

  /** The QR code as text, for a notification. */
  qrText() {
    const p = this.pairing();
    return p ? QrCode.get(p.qr_code) : '';
  }

  /** Let another controller pair: Apple, Google and Alexa can share the bridge. */
  async openPairing() {
    await this.server?.act((agent) => agent.commissioning.enterCommissionableMode());
  }

  async stop() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const id of this.entities.keys()) owners.delete(endpointId(id));
    this.entities.clear();
    const s = this.server;
    this.server = null;
    await s?.close();
  }

  /** Call a service in HomewrightHQ for a controller's change, and log a failure. */
  call(entityId, domain, service, data) {
    this.o.callService(domain, service, { entity_id: entityId, ...data }).catch((e) => {
      process.stderr.write(`WARN ${domain}.${service} on ${entityId}: ${e?.message ?? e}\n`);
    });
  }

  /** Collect a controller's changes to an entity and call once they settle. */
  #collect(entityId, changes, flush) {
    const p = this.pending.get(entityId) ?? { changes: {} };
    clearTimeout(p.timer);
    Object.assign(p.changes, changes);
    p.timer = setTimeout(() => {
      this.pending.delete(entityId);
      flush(p.changes);
    }, SETTLE_MS);
    this.pending.set(entityId, p);
  }

  #listen(endpoint, kind, entityId) {
    const ev = endpoint.events;
    // only changes from a controller; our own `set` runs offline
    const remote = (fn) => (value, _old, ctx) => {
      if (!ctx?.offline) fn(value);
    };
    switch (kind.kind) {
      case 'onoff_light':
      case 'dimmable_light':
      case 'ct_light':
      case 'color_light': {
        const light = (changes) =>
          this.#collect(entityId, changes, (c) => {
            const { service, data } = lightCall(c);
            this.call(entityId, 'light', service, data);
          });
        ev.onOff.onOff$Changed.on(remote((on) => light({ on })));
        if (kind.kind !== 'onoff_light') ev.levelControl.currentLevel$Changed.on(remote((level) => level !== null && light({ level })));
        if (ev.colorControl) {
          ev.colorControl.colorTemperatureMireds$Changed.on(remote((mireds) => light({ mireds, hue: undefined, sat: undefined })));
          if (kind.kind === 'color_light') {
            const hs = () => {
              const s = endpoint.state.colorControl;
              light({ hue: s.currentHue, sat: s.currentSaturation, mireds: undefined });
            };
            ev.colorControl.currentHue$Changed.on(remote(hs));
            ev.colorControl.currentSaturation$Changed.on(remote(hs));
            const xy = () => {
              const s = endpoint.state.colorControl;
              light({ x: s.currentX, y: s.currentY, hue: undefined, sat: undefined, mireds: undefined });
            };
            ev.colorControl.currentX$Changed.on(remote(xy));
            ev.colorControl.currentY$Changed.on(remote(xy));
          }
        }
        break;
      }
      case 'plug': {
        const domain = entityId.split('.')[0];
        ev.onOff.onOff$Changed.on(remote((on) => this.call(entityId, domain, on ? 'turn_on' : 'turn_off', {})));
        break;
      }
      case 'fan': {
        const fan = (changes) =>
          this.#collect(entityId, changes, (c) => {
            if (c.percent === 0) this.call(entityId, 'fan', 'turn_off', {});
            else if (typeof c.percent === 'number') this.call(entityId, 'fan', 'set_percentage', { percentage: c.percent });
            else this.call(entityId, 'fan', 'turn_on', {});
          });
        ev.fanControl.percentSetting$Changed.on(remote((p) => p !== null && fan({ percent: p })));
        ev.fanControl.fanMode$Changed.on(
          remote((mode) => {
            // 0 off, 1-3 low/medium/high, 4 on, 5 auto
            if (mode === 0) fan({ percent: 0 });
            else if (mode >= 1 && mode <= 3) fan({ percent: [33, 66, 100][mode - 1] });
            else fan({});
          }),
        );
        break;
      }
      case 'thermostat': {
        const setpoint = (v) => v !== null && this.#collect(entityId, { temperature: v / 100 }, (c) => this.call(entityId, 'climate', 'set_temperature', c));
        ev.thermostat.occupiedHeatingSetpoint$Changed.on(remote(setpoint));
        if (kind.cooling) ev.thermostat.occupiedCoolingSetpoint$Changed.on(remote(setpoint));
        ev.thermostat.systemMode$Changed.on(
          remote((mode) => {
            const hvac = { 0: 'off', 3: 'cool', 4: 'heat' }[mode];
            if (hvac) this.call(entityId, 'climate', 'set_hvac_mode', { hvac_mode: hvac });
          }),
        );
        break;
      }
      default:
        // covers have their own behavior; sensors take no commands
        break;
    }
  }
}
