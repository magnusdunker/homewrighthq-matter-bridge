// SDK til eksterne HomewrightHQ-integrationer i JavaScript.
//
// En ekstern integration er et selvstændigt program. HomewrightHQ starter det og
// taler med det over JSON-RPC 2.0 på stdin og stdout, én besked pr. linje.
// stderr er integrationens log. Programmet stopper, når stdin lukkes.
//
// Ingen afhængigheder. Virker med Node 18+ og Bun.
//
//   import { run } from '../sdk/homewright-plugin.js';
//   run({
//     async setupEntry(host, entry) {
//       const id = await host.addEntity(entry.entry_id, { domain: 'sensor', unique_id: 'mine-1' });
//       if (id) await host.setState(id, '42');
//     },
//   });

import { createInterface } from 'node:readline';
import path from 'node:path';

/** Versionen af protokollen, som denne SDK taler. */
export const API_VERSION = 1;

const HOST_TIMEOUT_MS = 30_000;

/**
 * En fejl til HomewrightHQ. `kind` afgør, hvad HomewrightHQ gør: `not_ready` prøver
 * igen senere, `auth_failed` beder brugeren logge ind igen,
 * `invalid_argument`, `not_supported`, `unavailable` og `not_found` vises ved
 * tjenestekald, og `failed` er alt andet.
 */
export class PluginError extends Error {
  /** @param {string} kind @param {string} message */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
  static notReady(m) { return new PluginError('not_ready', m); }
  static authFailed(m) { return new PluginError('auth_failed', m); }
  static failed(m) { return new PluginError('failed', m); }
  static invalid(m) { return new PluginError('invalid_argument', m); }
  static notSupported(m) { return new PluginError('not_supported', m); }
  static unavailable(m) { return new PluginError('unavailable', m); }
}

/** Skriv til HomewrightHQ's log. `level`: `ERROR`, `WARN`, `INFO` eller `DEBUG`. */
export function log(level, message) {
  process.stderr.write(`${level} ${message}\n`);
}

/**
 * @typedef {object} Entry En opsætning af integrationen.
 * @property {string} entry_id
 * @property {string} domain
 * @property {string} title
 * @property {Record<string, any>} data
 * @property {Record<string, any> | null} options
 * @property {string | null} [unique_id]
 *
 * @typedef {object} Flow Et opsætningsforløb i gang.
 * @property {string} flow_id
 * @property {string} source `user`, `options`, `reauth`, `zeroconf` ...
 * @property {any} [discovery]
 * @property {Record<string, any>} data Data samlet i tidligere trin.
 * @property {string | null} [unique_id]
 * @property {Entry | null} [entry] Ved options- og reauth-forløb.
 *
 * @typedef {object} FlowReply
 * @property {object} result
 * @property {Record<string, any>} [data]
 * @property {string} [unique_id]
 *
 * @typedef {object} Integration Det, en integration implementerer. Kun
 *   `setupEntry` er påkrævet.
 * @property {(host: Host, flow: Flow, step: string, input: any) => Promise<FlowReply>} [configFlow]
 * @property {(host: Host, flow: Flow, step: string, input: any) => Promise<FlowReply>} [optionsFlow]
 * @property {(host: Host, entry: Entry) => Promise<void>} setupEntry
 * @property {(host: Host, entryId: string) => Promise<void>} [unloadEntry]
 * @property {(host: Host, entryId: string, entityId: string, service: string, data: object) => Promise<void>} [entityService]
 * @property {(host: Host, entryId: string, service: string, data: object, entityIds: string[]) => Promise<any>} [domainService]
 * @property {(host: Host, entry: Entry) => Promise<any>} [diagnostics]
 * @property {(host: Host, entry: Entry, device: object) => Promise<void>} [removeDevice]
 * @property {(host: Host, entityId: string, newState: object | null) => void} [stateChanged]
 *   En ændring i en entity fra `subscribeStates`.
 */

/** Byggere til svar i opsætningsforløb. */
export const flow = {
  /** Vis en formular. `schema` er et JSON Schema-objekt (`type: object`). */
  form: (stepId, schema, errors) => ({ result: { type: 'form', step_id: stepId, schema, ...(errors ? { errors } : {}) } }),
  menu: (stepId, options) => ({ result: { type: 'menu', step_id: stepId, options } }),
  /** Afslut og opret opsætningen. I et options-forløb bliver `data` de nye options. */
  create: (title, data) => ({ result: { type: 'create_entry', title, data } }),
  abort: (reason) => ({ result: { type: 'abort', reason } }),
};

/** Forbindelsen til HomewrightHQ. */
export class Host {
  #send;
  #pending = new Map();
  #nextId = 1;
  /** Integrationens egen mappe til filer. Den bevares ved opdateringer. */
  /** Serverens sprog fra systemindstillingerne, fx `da` eller `en`. */
  language = 'da';
  dataDir = process.env.HOMEWRIGHT_DATA_DIR ?? process.env.THEHOME_DATA_DIR ?? path.resolve('data');

  constructor(send) {
    this.#send = send;
  }

  /** Kald en metode i HomewrightHQ og vent på svaret. */
  request(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(PluginError.failed(`${method}: HomewrightHQ svarede ikke`));
      }, HOST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** @internal Et svar på et af vores egne kald. */
  _reply(msg) {
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new PluginError(msg.error.data?.kind ?? 'failed', msg.error.message ?? ''));
    else p.resolve(msg.result ?? null);
  }

  /** @internal */
  _close() {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(PluginError.notReady('forbindelsen til HomewrightHQ er lukket'));
    }
    this.#pending.clear();
  }

  /** Registrér en enhed. Returnerer dens id. */
  async registerDevice(entryId, device) {
    const d = await this.request('device/register', { entry_id: entryId, device });
    return d.id;
  }

  /**
   * Tilføj en entity. Med `handler` sender HomewrightHQ dens tjenestekald til
   * `entityService`. Returnerer entity_id, eller `null` hvis brugeren har slået den fra.
   */
  async addEntity(entryId, entity, handler = false) {
    const r = await this.request('entity/add', { entry_id: entryId, entity, handler });
    return r?.entity_id ?? null;
  }

  async setState(entityId, state, attributes = {}) {
    await this.request('state/set', { entity_id: entityId, state: String(state), attributes });
  }

  async setUnavailable(entityId) {
    await this.request('state/unavailable', { entity_id: entityId });
  }

  /** Tilstanden af en vilkårlig entity, eller `null`. */
  getState(entityId) {
    return this.request('state/get', { entity_id: entityId });
  }

  /** Tilstandene af alle entities, eller kun dem i `domains`. Kræver HomewrightHQ 0.5.36. */
  allStates(domains) {
    return this.request('state/all', domains ? { domains } : {});
  }

  /**
   * Følg ændringerne i `entityIds`. De ender i `stateChanged`. Listen erstatter
   * den forrige, og en tom liste stopper dem. Kræver HomewrightHQ 0.5.36.
   */
  async subscribeStates(entityIds) {
    await this.request('state/subscribe', { entity_ids: entityIds });
  }

  /** Registrér tjenesten `<domæne>.<service>`. Kald ender i `domainService`. */
  async registerService(entryId, service, description) {
    await this.request('service/register', { entry_id: entryId, service, description });
  }

  /** Kald en tjeneste i HomewrightHQ, f.eks. `light.turn_on`. */
  callService(domain, service, data = {}) {
    return this.request('hub/call_service', { domain, service, data });
  }

  async fireEvent(eventType, data = {}) {
    await this.request('event/fire', { event_type: eventType, data });
  }

  /** Bed brugeren rette noget. `severity`: `warning` eller `error`. */
  async createIssue(entryId, issueId, severity, title, description) {
    await this.request('issue/create', { entry_id: entryId, issue_id: issueId, severity, title, description });
  }

  async deleteIssue(entryId, issueId) {
    await this.request('issue/delete', { entry_id: entryId, issue_id: issueId });
  }

  /** Gem ny data (f.eks. et fornyet token) på opsætningen. */
  async updateEntryData(entryId, data) {
    await this.request('entry/update', { entry_id: entryId, data });
  }
}

function toWire(e) {
  const kind = e instanceof PluginError ? e.kind : 'failed';
  return { code: -32000, message: String(e?.message ?? e), data: { kind } };
}

/**
 * Håndtér én besked fra HomewrightHQ. Eksporteret til test.
 * @param {Integration} integration
 * @param {Host} host
 */
export async function handle(integration, host, method, p = {}) {
  switch (method) {
    case 'initialize':
      if (p.data_dir) host.dataDir = p.data_dir;
      if (p.language) host.language = p.language;
      return { api_version: API_VERSION, ...(integration.optionsFlow ? { options_flow: true } : {}) };
    case 'config_flow':
    case 'options_flow': {
      const fn = method === 'config_flow' ? integration.configFlow : integration.optionsFlow;
      if (!fn) return flow.abort('not_supported');
      return fn.call(integration, host, p.flow ?? {}, p.step ?? '', p.input ?? null);
    }
    case 'setup_entry':
      await integration.setupEntry(host, p.entry);
      return null;
    case 'unload_entry':
      await integration.unloadEntry?.(host, p.entry_id);
      return null;
    case 'entity/call_service':
      if (!integration.entityService) throw PluginError.notSupported(`${p.service} på ${p.entity_id}`);
      await integration.entityService(host, p.entry_id, p.entity_id, p.service, p.data ?? {});
      return null;
    case 'service/call':
      if (!integration.domainService) throw PluginError.notSupported(p.service);
      return (await integration.domainService(host, p.entry_id, p.service, p.data ?? {}, p.entity_ids ?? [])) ?? null;
    case 'diagnostics':
      return (await integration.diagnostics?.(host, p.entry)) ?? null;
    case 'state/changed':
      integration.stateChanged?.(host, p.entity_id, p.new_state ?? null);
      return null;
    case 'remove_device':
      await integration.removeDevice?.(host, p.entry, p.device);
      return null;
    default:
      throw PluginError.notSupported(`ukendt metode ${method}`);
  }
}

/**
 * Kør integrationen, indtil HomewrightHQ lukker stdin eller beder om at stoppe.
 * @param {Integration} integration
 */
export function run(integration) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const host = new Host(send);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => {
    host._close();
    rl.close();
    process.exit(0);
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('WARN', `ugyldig besked fra HomewrightHQ: ${line}`);
      return;
    }
    if (typeof msg.method !== 'string') {
      host._reply(msg);
      return;
    }
    if (msg.method === 'shutdown') {
      stop();
      return;
    }
    const id = msg.id ?? null;
    // Hver besked håndteres for sig, så integrationen kan kalde HomewrightHQ imens.
    handle(integration, host, msg.method, msg.params ?? {}).then(
      (result) => id !== null && send({ jsonrpc: '2.0', id, result }),
      (err) => {
        if (id !== null) send({ jsonrpc: '2.0', id, error: toWire(err) });
        else log('WARN', `${msg.method}: ${err?.message ?? err}`);
      },
    );
  });
  rl.on('close', stop);
}
