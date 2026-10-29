// The HomewrightHQ side: setup and options, the pairing entity, and keeping
// the bridge's endpoints in step with the entities.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { flow, log, PluginError } from '../sdk/homewright-plugin.js';
import { Bridge } from './bridge.js';
import { DOMAINS, kindOf } from './mapping.js';

const DEFAULT_PORT = 5540;
const NOTIFICATION_ID = 'matter_bridge_pairing';
const TEXT = {
  da: {
    title: 'Matter-broen er klar til parring',
    message: (code) =>
      `Tilføj broen i Apple Home, Google Home eller Alexa som en Matter-enhed. Skan QR-koden, eller skriv koden **${code}**.\n\n` +
      'Appen advarer om, at enheden ikke er certificeret. Vælg at tilføje den alligevel.',
  },
  en: {
    title: 'The Matter bridge is ready to pair',
    message: (code) =>
      `Add the bridge in Apple Home, Google Home or Alexa as a Matter device. Scan the QR code, or enter the code **${code}**.\n\n` +
      'The app warns that the device is not certified. Choose to add it anyway.',
  },
};

function schema(cur = {}) {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Navn', default: cur.name ?? 'HomewrightHQ', description: 'Broens navn i Apple Home, Google Home og Alexa' },
      entities: {
        type: 'array',
        title: 'Enheder',
        items: { type: 'string' },
        default: cur.entities ?? [],
        description: 'Lys, kontakter, ventilatorer, gardiner, termostater og sensorer for temperatur, fugt, lys, døre, bevægelse og vand',
        'x-selector': { entity: { domain: DOMAINS, multiple: true } },
      },
      port: { type: 'integer', title: 'Port', default: cur.port ?? DEFAULT_PORT, minimum: 1024, maximum: 65535, description: 'UDP-porten til Matter' },
    },
    required: ['name', 'entities'],
  };
}

function settings(entry) {
  const o = entry.options && Object.keys(entry.options).length ? entry.options : entry.data;
  return { name: o.name ?? entry.data.name ?? 'HomewrightHQ', entities: o.entities ?? [], port: Number(o.port ?? entry.data.port ?? DEFAULT_PORT) };
}

function check(input) {
  const errors = {};
  if (!String(input.name ?? '').trim()) errors.name = 'required';
  if (!Array.isArray(input.entities) || input.entities.length === 0) errors.entities = 'no_entities';
  const port = Number(input.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.port = 'bad_port';
  return errors;
}

const clean = (input) => ({ name: String(input.name).trim(), entities: [...new Set(input.entities)], port: Number(input.port ?? DEFAULT_PORT) });

/** A serial number that stays the same for this installation. */
function serial(dir) {
  const file = path.join(dir, 'serial');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const s = 'hw-' + createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16);
  writeFileSync(file, s);
  return s;
}

export class MatterBridgeIntegration {
  constructor() {
    /** entry id → { bridge, pairingEntity, entry } */
    this.running = new Map();
  }

  async configFlow(_host, _flow, _step, input) {
    if (!input) return flow.form('user', schema());
    const errors = check(input);
    if (Object.keys(errors).length) return { result: { type: 'form', step_id: 'user', schema: schema(input), errors } };
    const data = clean(input);
    return { ...flow.create(data.name, data), unique_id: 'matter_bridge' };
  }

  async optionsFlow(_host, f, _step, input) {
    const cur = f.entry ? settings(f.entry) : {};
    if (!input) return flow.form('init', schema(cur));
    const errors = check(input);
    if (Object.keys(errors).length) return { result: { type: 'form', step_id: 'init', schema: schema(input), errors } };
    return flow.create('', clean(input));
  }

  async setupEntry(host, entry) {
    const s = settings(entry);
    const dir = path.join(host.dataDir, 'matter');
    mkdirSync(dir, { recursive: true });

    let states;
    try {
      states = await host.allStates(DOMAINS);
    } catch (e) {
      if (/unknown method|-32601|method not found/i.test(String(e?.message))) {
        throw PluginError.failed('Matter-broen kræver HomewrightHQ 0.5.36 eller nyere');
      }
      throw e;
    }
    const byId = new Map(states.map((st) => [st.entity_id, st]));
    // entities that are gone or not loaded yet still get an endpoint, shown as unreachable
    const chosen = s.entities.map((id) => byId.get(id) ?? { entity_id: id, state: 'unavailable', attributes: {} });
    const unknown = chosen.filter((st) => !kindOf(st) && byId.has(st.entity_id)).map((st) => st.entity_id);

    const deviceId = await host.registerDevice(entry.entry_id, {
      identifiers: [['matter_bridge', entry.entry_id]],
      name: s.name,
      manufacturer: 'HomewrightHQ',
      model: 'Matter bridge',
    });
    const pairingEntity = await host.addEntity(entry.entry_id, {
      domain: 'sensor',
      unique_id: `${entry.entry_id}-pairing`,
      device_id: deviceId,
      name: 'Parring',
      icon: 'mdi:qrcode',
      device_class: 'enum',
      capabilities: { options: ['not_paired', 'paired'] },
    });

    const run = { bridge: null, pairingEntity, entry, host };
    const bridge = new Bridge({
      storagePath: dir,
      port: s.port,
      name: s.name,
      serial: serial(host.dataDir),
      callService: (domain, service, data) => host.callService(domain, service, data),
      onPairingChanged: () => this.#showPairing(run).catch((e) => log('WARN', `pairing: ${e?.message ?? e}`)),
    });
    run.bridge = bridge;
    try {
      const skipped = await bridge.start(chosen.filter((st) => !unknown.includes(st.entity_id)));
      for (const id of [...unknown, ...skipped.filter((id) => !unknown.includes(id))]) log('WARN', `${id} kan ikke vises i Matter og springes over`);
    } catch (e) {
      await bridge.stop().catch(() => {});
      if (e?.code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(String(e?.message))) {
        throw PluginError.notReady(`Port ${s.port} er optaget. Vælg en anden under Indstillinger.`);
      }
      throw PluginError.notReady(`Matter-broen kunne ikke starte: ${e?.message ?? e}`);
    }
    this.running.set(entry.entry_id, run);
    await host.registerService(entry.entry_id, 'open_pairing', {
      name: 'Åbn for parring',
      description: 'Lad en app mere tilføje broen, fx Google Home ved siden af Apple Home. Koden vises i en notifikation.',
      fields: {},
    });
    await host.subscribeStates([...bridge.entities.keys()]);
    await this.#showPairing(run);
  }

  async unloadEntry(host, entryId) {
    const run = this.running.get(entryId);
    this.running.delete(entryId);
    if (!run) return;
    await host.subscribeStates([]).catch(() => {});
    await run.bridge.stop();
  }

  stateChanged(_host, entityId, newState) {
    for (const run of this.running.values()) {
      run.bridge.update(entityId, newState ?? { entity_id: entityId, state: 'unavailable', attributes: {} });
    }
  }

  async domainService(host, entryId, service) {
    const run = this.running.get(entryId) ?? [...this.running.values()][0];
    if (!run) throw PluginError.unavailable('Matter-broen kører ikke');
    if (service === 'open_pairing') {
      await run.bridge.openPairing();
      await this.#showPairing(run, true);
      return null;
    }
    throw PluginError.notSupported(service);
  }

  async diagnostics(_host, entry) {
    const run = this.running.get(entry.entry_id);
    if (!run) return { running: false };
    const p = run.bridge.pairing();
    return {
      running: true,
      commissioned: p?.commissioned ?? false,
      fabrics: p?.fabrics ?? [],
      entities: [...run.bridge.entities.values()].map((e) => ({ entity_id: e.entityId, kind: e.kind.kind })),
    };
  }

  /** The pairing entity's state, and a notification with the code while nothing has paired. */
  async #showPairing(run, open = false) {
    const p = run.bridge.pairing();
    if (!p) return;
    const { host, pairingEntity } = run;
    if (pairingEntity) {
      await host.setState(pairingEntity, p.commissioned ? 'paired' : 'not_paired', {
        manual_code: p.manual_code,
        qr_code: p.qr_code,
        fabrics: p.fabrics.length,
        entities: run.bridge.entities.size,
      });
    }
    if (p.commissioned && !open) {
      await host.callService('persistent_notification', 'dismiss', { notification_id: NOTIFICATION_ID }).catch(() => {});
      return;
    }
    const code = p.manual_code.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1-$2-$3');
    const t = String(host.language).startsWith('da') ? TEXT.da : TEXT.en;
    await host
      .callService('persistent_notification', 'create', {
        notification_id: NOTIFICATION_ID,
        title: t.title,
        message: `${t.message(code)}\n\n\`\`\`\n${run.bridge.qrText()}\n\`\`\``,
      })
      .catch((e) => log('WARN', `notification: ${e?.message ?? e}`));
  }
}
