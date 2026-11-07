import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { MqttClient, topicMatches } from "../src/mqtt.ts";

const str = (s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const pkt = (b0: number, body: Buffer) => {
  const v: number[] = []; let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; v.push(d); } while (n);
  return Buffer.concat([Buffer.from([b0, ...v]), body]);
};
const pub = (topic: string, payload: string) => pkt(0x30, Buffer.concat([str(topic), Buffer.from(payload)]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Conn = { clientId: string; username?: string; password?: string; willTopic?: string; willPayload?: string; willRetain: boolean };
type Broker = Awaited<ReturnType<typeof broker>>;

// Kleine nep-broker
async function broker() {
  const connects: Conn[] = [];
  const published: { topic: string; payload: string; retain: boolean }[] = [];
  const socks = new Set<net.Socket>();
  const subs = new Map<net.Socket, string[]>();
  let pings = 0, disconnects = 0;
  const server = net.createServer((s) => {
    socks.add(s); s.setNoDelay(true);
    let buf = Buffer.alloc(0);
    s.on("error", () => {});
    s.on("close", () => { socks.delete(s); subs.delete(s); });
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = 0, m = 1, i = 1;
        while (buf[i] & 128) { len += (buf[i] & 127) * m; m *= 128; i++; }
        len += buf[i] * m;
        if (buf.length < i + 1 + len) break;
        const b0 = buf[0], body = buf.subarray(i + 1, i + 1 + len);
        buf = buf.subarray(i + 1 + len);
        const type = b0 >> 4;
        if (type === 1) {
          let o = 2 + body.readUInt16BE(0) + 1; // "MQTT", level
          const fl = body[o++]; o += 2; // keepalive
          const rd = () => { const l = body.readUInt16BE(o); const r = body.toString("utf8", o + 2, o + 2 + l); o += 2 + l; return r; };
          const c: Conn = { clientId: rd(), willRetain: !!(fl & 0x20) };
          if (fl & 0x04) { c.willTopic = rd(); c.willPayload = rd(); }
          if (fl & 0x80) c.username = rd();
          if (fl & 0x40) c.password = rd();
          connects.push(c);
          s.write(Buffer.from([0x20, 2, 0, 0]));
        } else if (type === 8) {
          const tl = body.readUInt16BE(2);
          subs.set(s, [...(subs.get(s) ?? []), body.toString("utf8", 4, 4 + tl)]);
          s.write(Buffer.from([0x90, 3, body[0], body[1], 0]));
        } else if (type === 3) {
          const tl = body.readUInt16BE(0), topic = body.toString("utf8", 2, 2 + tl), payload = body.toString("utf8", 2 + tl);
          published.push({ topic, payload, retain: !!(b0 & 1) });
          for (const [o, fs] of subs) if (fs.some((f) => topicMatches(f, topic))) o.write(pub(topic, payload));
        } else if (type === 12) { pings++; s.write(Buffer.from([0xd0, 0])); }
        else if (type === 14) { disconnects++; s.end(); }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, connects, published, subs, socks,
    get pings() { return pings; }, get disconnects() { return disconnects; },
    dropAll: () => { for (const s of socks) s.destroy(); },
    close: async () => { for (const s of socks) s.destroy(); server.close(); await once(server, "close"); },
  };
}

async function setup(reconnectMs = 20) {
  const b = await broker();
  const c = new MqttClient(`mqtt://us%40er:p%3Ass@127.0.0.1:${b.port}`, { clientId: "weekmand", keepalive: 1, reconnectMs, will: { topic: "weekmand/status", payload: "offline", retain: true } });
  c.connect();
  await once(c, "connect");
  return { b, c };
}
const teardown = async (b: Broker, c: MqttClient) => { await c.end(); await b.close(); };

test("verbindt met user/pass en will; publish komt aan met retain", async () => {
  const { b, c } = await setup();
  assert.equal(c.connected, true);
  assert.deepEqual(b.connects[0], { clientId: "weekmand", username: "us@er", password: "p:ss", willTopic: "weekmand/status", willPayload: "offline", willRetain: true });
  assert.equal(c.publish("a/b", "hallo", { retain: true }), true);
  c.publish("a/c", Buffer.from("x"));
  await sleep(50);
  assert.deepEqual(b.published, [{ topic: "a/b", payload: "hallo", retain: true }, { topic: "a/c", payload: "x", retain: false }]);
  await teardown(b, c);
  assert.equal(c.publish("a/b", "x"), false);
  assert.equal(b.disconnects, 1);
});

test("keepalive stuurt PINGREQ en verwerkt PINGRESP", async () => {
  const { b, c } = await setup();
  await sleep(1200);
  assert.ok(b.pings >= 1);
  assert.equal(c.connected, true);
  await teardown(b, c);
});

test("subscribe + bericht van broker met wildcard-filter", async () => {
  const { b, c } = await setup();
  c.subscribe("sensor/+/state");
  await sleep(50);
  const got = once(c, "message");
  c.publish("sensor/x/state", "42"); // broker stuurt door naar abonnee (ook onszelf)
  const [topic, payload] = await got;
  assert.equal(topic, "sensor/x/state");
  assert.equal(payload.toString(), "42");
  await teardown(b, c);
});

test("reconnect na sluiten door broker en opnieuw abonneren", async () => {
  const { b, c } = await setup();
  c.subscribe("home/#");
  await sleep(50);
  const closed = once(c, "close");
  b.dropAll();
  await closed;
  assert.equal(c.connected, false);
  await once(c, "connect");
  await sleep(50);
  assert.equal(b.connects.length, 2);
  assert.deepEqual([...b.subs.values()], [["home/#"]]);
  const got = once(c, "message");
  c.publish("home/kamer", "aan");
  assert.equal((await got)[0], "home/kamer");
  await teardown(b, c);
});

test("pakketten over meerdere writes gesplitst en twee pakketten in één write", async () => {
  const { b, c } = await setup();
  const seen: string[] = [];
  c.on("message", (t: string, p: Buffer) => seen.push(`${t}=${p}`));
  const s = [...b.socks][0];
  const one = pub("t/een", "x".repeat(200)); // remaining length van 2 bytes
  s.write(one.subarray(0, 2)); await sleep(30);
  s.write(one.subarray(2, 100)); await sleep(30);
  s.write(one.subarray(100)); await sleep(30);
  s.write(Buffer.concat([pub("t/twee", "2"), pub("t/drie", "3")]));
  await sleep(50);
  assert.deepEqual(seen, [`t/een=${"x".repeat(200)}`, "t/twee=2", "t/drie=3"]);
  await teardown(b, c);
});

test("inkomend QoS 1 wordt met PUBACK bevestigd", async () => {
  const { b, c } = await setup();
  const s = [...b.socks][0];
  const ack = once(s, "data");
  const got = once(c, "message");
  s.write(pkt(0x32, Buffer.concat([str("q/1"), Buffer.from([0, 7]), Buffer.from("hi")])));
  assert.equal((await got)[1].toString(), "hi");
  assert.deepEqual([...(await ack)[0]], [0x40, 2, 0, 7]);
  await teardown(b, c);
});

test("topicMatches", () => {
  assert.ok(topicMatches("sensor/+/state", "sensor/kamer/state"));
  assert.ok(!topicMatches("sensor/+/state", "sensor/kamer/x/state"));
  assert.ok(!topicMatches("sensor/+/state", "sensor/kamer"));
  assert.ok(topicMatches("home/#", "home/a/b/c"));
  assert.ok(topicMatches("home/#", "home"));
  assert.ok(!topicMatches("home/#", "other/a"));
  assert.ok(topicMatches("a/b", "a/b"));
  assert.ok(!topicMatches("a/b", "a/b/c"));
  assert.ok(!topicMatches("a/b/c", "a/b"));
  assert.ok(topicMatches("#", "x/y"));
  assert.ok(!topicMatches("#", "$SYS/x"));
});

test("mislukte verbinding crasht niet zonder error-listener; end() stopt reconnects", async () => {
  const b0 = await broker();
  const port = b0.port;
  await b0.close(); // poort dicht
  const c0 = new MqttClient(`mqtt://127.0.0.1:${port}`, { clientId: "x", reconnectMs: 10 });
  c0.connect();
  await sleep(100);
  await c0.end();
  const { b, c } = await setup();
  await c.end();
  await sleep(100);
  assert.equal(b.connects.length, 1); // geen reconnect na end()
  await b.close();
});
