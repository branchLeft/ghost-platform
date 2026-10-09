// Run inside the spool's container: `node - COUNT < drainack.js`. Drains the
// spool with its own token (read from its environment, never printed) and
// acks what it is handed, so the messages leave the queue without being
// delivered anywhere. Exits 0 only once COUNT messages have been acked. The
// spool's throttle hands over one message at a time at first, so this loops.
const want = Number(process.argv[2]);
const base = 'http://127.0.0.1:8080';
const auth = { Authorization: `Bearer ${process.env.SHIM_DRAIN_TOKEN}` };

async function main() {
  let acked = 0;
  for (let poll = 0; poll < 8 && acked < want; poll += 1) {
    const { messages } = await (await fetch(`${base}/drain`, { headers: auth })).json();
    if (messages.length === 0) continue;
    const res = await fetch(`${base}/drain/ack`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: messages.map((m) => ({ id: m.id, drainCount: m.drainCount })) }),
    });
    if (!res.ok) throw new Error(`ack answered ${res.status}`);
    for (const m of messages) console.log(`acked: ${m.subject}`);
    acked += messages.length;
  }
  console.log(`acked in total: ${acked}`);
  process.exit(acked === want ? 0 : 1);
}

main().catch((err) => {
  console.log(`failed: ${err.message}`);
  process.exit(1);
});
