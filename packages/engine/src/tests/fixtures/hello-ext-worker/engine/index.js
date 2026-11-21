// Hand-written from engine/index.ts: a declared route, nothing to bundle.
export default {
  name: 'hello-ext-worker',
  category: 'fixture',
  routes: {
    health: () =>
      Response.json({ ok: true, name: 'hello-ext-worker', isolation: 'worker', runtime: 'bun-worker' }),
  },
  async register() {},
};
