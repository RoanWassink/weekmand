import { randomBytes } from 'node:crypto';
import { handleAction } from './actions.ts';
import type { Notice, Weekmand } from './app.ts';
import { version } from './mcp.ts';
import { MqttClient } from './mqtt.ts';

/**
 * Home Assistant via MQTT met automatische ontdekking (MQTT discovery):
 * sensoren voor het menu, wat op is en de deadline; knoppen voor "weekmenu goedkeuren",
 * "mand bijwerken" en "<product> is op" (bijv. voor een Zigbee-knop in de voorraadkast).
 * Commando's: <prefix>/cmd/op met als bericht een productnaam, of <prefix>/cmd/op/<sleutel>.
 */
export class HomeAssistantBridge {
  #app: Weekmand;
  #client: MqttClient;
  #prefix: string;
  #discovery: string;
  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  lastMessage: string | null = null;

  constructor(app: Weekmand, url: string, prefix = process.env.MQTT_PREFIX || 'weekmand', discovery = process.env.MQTT_DISCOVERY_PREFIX || 'homeassistant') {
    this.#app = app;
    this.#prefix = prefix.replace(/[^a-z0-9_/-]/gi, '') || 'weekmand';
    this.#discovery = discovery;
    this.#client = new MqttClient(url, {
      clientId: 'weekmand-' + randomBytes(4).toString('hex'),
      will: { topic: this.#prefix + '/status', payload: 'offline', retain: true },
    });
  }

  get connected() { return this.#client.connected; }

  start() {
    const c = this.#client;
    c.on('error', (error: Error) => { this.lastMessage = error.message; });
    c.on('connect', () => {
      this.lastMessage = null;
      this.#announce();
      c.publish(this.#prefix + '/status', 'online', { retain: true });
      c.subscribe(this.#prefix + '/cmd/#');
      void this.publishState();
    });
    c.on('message', (topic: string, payload: Buffer) => void this.#command(topic, payload.toString('utf8').trim()));
    this.#app.events.on('change', () => {
      if (this.#debounce) clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => void this.publishState(), 2000);
      this.#debounce.unref();
    });
    this.#app.events.on('notify', (notice: Notice) => {
      c.publish(this.#prefix + '/notify', JSON.stringify({ title: 'Weekmand', message: notice.text }));
    });
    this.#timer = setInterval(() => void this.publishState(), 5 * 60_000);
    this.#timer.unref();
    c.connect();
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#client.publish(this.#prefix + '/status', 'offline', { retain: true });
    await this.#client.end();
  }

  async publishState() {
    if (!this.#client.connected) return;
    try {
      const snapshot = await this.#app.snapshot();
      this.#client.publish(this.#prefix + '/state', JSON.stringify(snapshot), { retain: true });
    } catch (error) {
      this.lastMessage = (error as Error).message;
    }
  }

  #announce() {
    const device = { identifiers: ['weekmand'], name: 'Weekmand', manufacturer: 'Weekmand', model: 'Boodschappenassistent', sw_version: version };
    const base = { availability_topic: this.#prefix + '/status', device };
    const state = this.#prefix + '/state';
    const sensor = (id: string, name: string, template: string, extra: Record<string, unknown> = {}) =>
      this.#client.publish(`${this.#discovery}/sensor/weekmand/${id}/config`, JSON.stringify({
        ...base, name, unique_id: 'weekmand_' + id, object_id: 'weekmand_' + id, state_topic: state, value_template: template, ...extra,
      }), { retain: true });
    const button = (id: string, name: string, topic: string, payload: string, icon: string) =>
      this.#client.publish(`${this.#discovery}/button/weekmand/${id}/config`, JSON.stringify({
        ...base, name, unique_id: 'weekmand_' + id, object_id: 'weekmand_' + id, command_topic: topic, payload_press: payload, icon,
      }), { retain: true });

    sensor('menu_vandaag', 'Menu vandaag', '{{ value_json.today }}', { icon: 'mdi:silverware-fork-knife' });
    sensor('menu_morgen', 'Menu morgen', '{{ value_json.tomorrow }}', { icon: 'mdi:silverware-fork-knife' });
    sensor('bijna_op', 'Bijna op', '{{ value_json.low_count }}', {
      icon: 'mdi:fridge-alert-outline', unit_of_measurement: 'producten',
      json_attributes_topic: state, json_attributes_template: '{{ {"producten": value_json.low} | tojson }}',
    });
    sensor('deadline', 'Picnic-deadline', "{{ value_json.cutoff if value_json.cutoff else 'unknown' }}", { device_class: 'timestamp', icon: 'mdi:clock-alert-outline' });
    sensor('voorstellen', 'Open voorstellen', '{{ value_json.open_suggestions }}', { icon: 'mdi:lightbulb-on-outline' });

    button('menu_goedkeuren', 'Weekmenu goedkeuren', this.#prefix + '/cmd/approve', 'PRESS', 'mdi:check-decagram');
    button('mand_bijwerken', 'Mand bijwerken', this.#prefix + '/cmd/apply', 'PRESS', 'mdi:cart-arrow-down');
    button('menu_voorstellen', 'Nieuw weekmenu voorstellen', this.#prefix + '/cmd/propose', 'PRESS', 'mdi:auto-fix');
    for (const key of this.#app.quickItems()) {
      const name = this.#app.catalog.ingredient(key)?.name ?? key;
      button('op_' + key.replace(/-/g, '_'), `${name} is op`, `${this.#prefix}/cmd/op/${key}`, 'PRESS', 'mdi:basket-remove-outline');
    }
  }

  async #command(topic: string, payload: string) {
    const command = topic.slice(this.#prefix.length + 5); // na "<prefix>/cmd/"
    const app = this.#app;
    let reply: string;
    try {
      if (command === 'op') reply = `${app.markOut(payload).name} is op.`;
      else if (command.startsWith('op/')) reply = `${app.markOut(command.slice(3)).name} is op.`;
      else if (command === 'approve') reply = (await handleAction(app, 'menu:approve')).text;
      else if (command === 'propose') { await app.proposeMenu({ wish: payload === 'PRESS' ? '' : payload }); reply = 'Nieuw weekmenu voorgesteld.'; }
      else if (command === 'apply') {
        const plan = await app.plan();
        reply = (await app.applyPlan(plan.id)).summary;
      } else return;
    } catch (error) {
      reply = (error as Error).message;
    }
    this.#client.publish(this.#prefix + '/result', JSON.stringify({ command, message: reply }));
    void this.publishState();
  }
}
