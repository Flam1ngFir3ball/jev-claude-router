// Counts the engine calls one turn costs, with a fake engine and Jev
// answering instantly, so what is left is the plugin's own overhead:
//   npm run bench-overhead
// A turn here is a prompt, 20 tool-using steps of 40 text pieces each, and
// a final step, on a session with 20 turns of history behind it.
import { register } from "../hooks/register.ts";

// LAG_MS adds a delay to every engine call and JEV_MS to the Jev call, to
// show wall time rather than call counts: LAG_MS=1 JEV_MS=300 npm run bench-overhead
const LAG_MS = Number(process.env.LAG_MS ?? 0);
const JEV_MS = Number(process.env.JEV_MS ?? 0);
const lag = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : undefined);
const counts: Record<string, number> = {};
const tick = async (k: string) => {
  counts[k] = (counts[k] ?? 0) + 1;
  await lag(k === "jev" ? JEV_MS : LAG_MS);
};
const store = new Map<string, unknown>();
let bytesWritten = 0;

const hooks = new Map<string, Function>();
const on = (name: string, a: unknown, b?: unknown) => {
  hooks.set(typeof a === "function" ? name : `${name}:${JSON.stringify(a)}`, (typeof a === "function" ? a : b) as Function);
  return { catch: () => {} };
};
register(on as never);

const env: Record<string, string> = { AI_GATEWAY_API_KEY: "k" };
const $ = {
  env: { get: async (k: string) => (await tick("env.get"), env[k]) },
  clock: { sleep: () => new Promise<never>(() => {}) },
  http: {
    fetch: async () => (
      await tick("jev"),
      {
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify({ answers: { tier: { type: "choice", choice: "opus", confidence: 0.9 }, effort: { type: "score", score: 2, confidence: 0.8 } } }),
      }
    ),
  },
  command: { register: async () => {} },
  store: {
    get: async (k: string) => (await tick("store.get"), store.get(k)),
    set: async (k: string, v: unknown) => {
      await tick("store.set");
      const s = JSON.stringify(v);
      bytesWritten += s.length;
      store.set(k, JSON.parse(s));
    },
    keys: async () => (await tick("store.keys"), [...store.keys()]),
    delete: async (k: string) => (await tick("store.delete"), store.delete(k)),
  },
  session: {
    id: async () => (await tick("session.id"), "bench"),
    surface: async () => "test",
    surfaces: async () => (await tick("session.surfaces"), ["test"]),
    model: async () => (await tick("session.model"), "claude-opus-5-5"),
    usage: async () => (await tick("session.usage"), { context: { tokens: 150_000 } }),
  },
  agent: { list: async () => (await tick("agent.list"), []) },
};

const usage = { model: "claude-opus-5-5", input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 };
async function* step(pieces: number, stopReason: string) {
  const text = "Working on it. ".repeat(pieces);
  for (let i = 0; i < pieces; i++) yield { kind: "text", index: 0, text: text.slice(i * 15, i * 15 + 15), ref: i + 1 };
  yield { kind: "stop", stopReason, usage, ref: 9999 };
  return { stopReason };
}

let startMs = 0;
async function turn(id: string, steps: number, pieces: number) {
  const t = performance.now();
  await hooks.get("turn.start")!($, { text: `turn ${id}: implement the thing`, turnId: id }, async (e: unknown) => e);
  startMs = performance.now() - t;
  for (let s = 0; s <= steps; s++) {
    const gen = hooks.get("turn.step")!($, { turnId: id, index: s }, () => step(pieces, s < steps ? "tool_use" : "end_turn"));
    for await (const _ of gen) void _;
  }
}

await hooks.get("session.start")!($, {}, async (e: unknown) => e);
for (let i = 0; i < 20; i++) await turn(`warm-${i}`, 2, 5);
for (const k of Object.keys(counts)) delete counts[k];
bytesWritten = 0;
const t0 = performance.now();
await turn("measured", 20, 40);
const ms = performance.now() - t0;
console.log(`one turn, 21 steps, 840 text pieces: ${ms.toFixed(1)}ms in the plugin (turn.start ${startMs.toFixed(1)}ms; engine lag ${LAG_MS}ms/call, Jev ${JEV_MS}ms)`);
console.log(`store bytes written: ${(bytesWritten / 1024).toFixed(1)}k`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
