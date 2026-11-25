// @bun
// ADR 0062 fail-alone probe. One action that misbehaves on purpose.
const keep = [];
const misbehave = async () => {
  while (true) {
    keep.push(new Uint8Array(16 << 20).fill(1));
    await new Promise((r) => setTimeout(r, 5));
  }
};
export default {
  name: 'probe/leak',
  category: 'probe',
  mountStrategy: 'subapp',
  actions: { misbehave },
  async register() {},
};
