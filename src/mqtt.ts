// Minimale MQTT 3.1.1-client (QoS 0, clean session), zonder afhankelijkheden.
import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";

export type MqttOptions = { clientId: string; keepalive?: number; will?: { topic: string; payload: string; retain?: boolean }; reconnectMs?: number };

// --- pakketcodering ---
const str = (s: string): Buffer => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };

function varint(n: number): Buffer {
  const out: number[] = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0);
  return Buffer.from(out);
}

const packet = (byte0: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([byte0]), varint(body.length), body]);
};

// Leest één pakket uit buf; null als het nog niet compleet is.
function readPacket(buf: Buffer): { type: number; flags: number; body: Buffer; size: number } | null {
  let len = 0, mult = 1, i = 1;
  for (;; i++) {
    if (i >= buf.length) return null;
    len += (buf[i] & 127) * mult;
    if (!(buf[i] & 128)) break;
    mult *= 128;
    if (i >= 4) throw new Error("ongeldige remaining length");
  }
  const size = i + 1 + len;
  if (buf.length < size) return null;
  return { type: buf[0] >> 4, flags: buf[0] & 15, body: buf.subarray(i + 1, size), size };
}

export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/"), t = topic.split("/");
  if (t[0].startsWith("$") && (f[0] === "#" || f[0] === "+")) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export class MqttClient extends EventEmitter {
  #url: URL;
  #opts: MqttOptions;
  #sock: net.Socket | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #up = false;
  #ended = false;
  #attempt = 0;
  #pid = 0;
  #subs = new Set<string>();
  #retry: NodeJS.Timeout | null = null;
  #ping: NodeJS.Timeout | null = null;
  #pingSent = 0; // tijdstip van openstaande PINGREQ, 0 = geen

  constructor(url: string, options: MqttOptions) {
    super();
    this.#url = new URL(url);
    this.#opts = options;
  }

  get connected(): boolean { return this.#up; }

  connect(): void {
    if (this.#ended || this.#sock) return;
    const u = this.#url, secure = u.protocol === "mqtts:";
    const host = u.hostname.replace(/^\[|\]$/g, ""), port = Number(u.port) || (secure ? 8883 : 1883);
    const sock: net.Socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    this.#sock = sock;
    this.#buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.on(secure ? "secureConnect" : "connect", () => this.#sendConnect());
    sock.on("data", (d: Buffer) => this.#onData(sock, d));
    sock.on("error", (e: Error) => this.#error(e));
    sock.on("close", () => this.#onClose(sock));
  }

  publish(topic: string, payload: string | Buffer, options: { retain?: boolean } = {}): boolean {
    if (!this.#up || !this.#sock) return false;
    this.#sock.write(packet(0x30 | (options.retain ? 1 : 0), str(topic), Buffer.from(payload)));
    return true;
  }

  subscribe(filter: string): void {
    this.#subs.add(filter);
    if (this.#up) this.#sendSubscribe(filter);
  }

  end(): Promise<void> {
    this.#ended = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const sock = this.#sock;
    if (!sock || sock.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const guard = setTimeout(() => sock.destroy(), 1000); // vangnet als de broker niet sluit
      guard.unref();
      sock.once("close", () => { clearTimeout(guard); resolve(); });
      if (this.#up) sock.end(Buffer.from([0xe0, 0])); // DISCONNECT, daarna FIN
      else sock.destroy();
    });
  }

  // --- intern ---
  #error(e: Error): void { if (this.listenerCount("error") > 0) this.emit("error", e); }

  #sendConnect(): void {
    const { clientId, keepalive = 30, will } = this.#opts;
    const user = decodeURIComponent(this.#url.username), pass = decodeURIComponent(this.#url.password);
    let flags = 0x02; // clean session
    const tail: Buffer[] = [str(clientId)];
    if (will) { flags |= 0x04 | (will.retain ? 0x20 : 0); tail.push(str(will.topic), str(will.payload)); }
    if (user) { flags |= 0x80; tail.push(str(user)); }
    if (user && pass) { flags |= 0x40; tail.push(str(pass)); }
    this.#sock?.write(packet(0x10, str("MQTT"), Buffer.from([4, flags, keepalive >> 8, keepalive & 255]), ...tail));
  }

  #sendSubscribe(filter: string): void {
    this.#pid = (this.#pid % 65535) + 1;
    this.#sock?.write(packet(0x82, Buffer.from([this.#pid >> 8, this.#pid & 255]), str(filter), Buffer.from([0])));
  }

  #onData(sock: net.Socket, chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    try {
      for (let p; (p = readPacket(this.#buf)); ) {
        this.#buf = this.#buf.subarray(p.size);
        this.#handle(sock, p.type, p.flags, p.body);
      }
    } catch (e) {
      this.#error(e as Error);
      sock.destroy();
    }
  }

  #handle(sock: net.Socket, type: number, flags: number, body: Buffer): void {
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.#error(new Error(`MQTT CONNACK geweigerd (code ${body[1]})`)); sock.destroy(); return; }
      this.#up = true;
      this.#attempt = 0;
      for (const f of this.#subs) this.#sendSubscribe(f);
      const ms = (this.#opts.keepalive ?? 30) * 500; // ping elke halve keepalive
      this.#pingSent = 0;
      this.#ping = setInterval(() => {
        if (this.#pingSent && Date.now() - this.#pingSent > ms * 3) { sock.destroy(); return; } // 1,5x keepalive zonder PINGRESP
        if (!this.#pingSent) { this.#pingSent = Date.now(); sock.write(Buffer.from([0xc0, 0])); }
      }, ms);
      this.#ping.unref();
      this.emit("connect");
    } else if (type === 3) { // PUBLISH
      const qos = (flags >> 1) & 3;
      const tl = body.readUInt16BE(0);
      const topic = body.toString("utf8", 2, 2 + tl);
      let off = 2 + tl;
      if (qos > 0) { sock.write(Buffer.from([0x40, 2, body[off], body[off + 1]])); off += 2; } // PUBACK
      this.emit("message", topic, Buffer.from(body.subarray(off)));
    } else if (type === 13) this.#pingSent = 0; // PINGRESP
  }

  #onClose(sock: net.Socket): void {
    if (this.#sock !== sock) return;
    const was = this.#up;
    this.#sock = null;
    this.#up = false;
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = null;
    this.emit("close", was);
    if (this.#ended) return;
    const delay = Math.min((this.#opts.reconnectMs ?? 5000) * 2 ** this.#attempt++, 60000);
    this.#retry = setTimeout(() => { this.#retry = null; this.connect(); }, delay);
    this.#retry.unref();
  }
}
