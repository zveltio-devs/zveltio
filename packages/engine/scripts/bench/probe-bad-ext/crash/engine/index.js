// @bun
// ADR 0062 fail-alone probe. One action that misbehaves on purpose.
const keep = [];
const misbehave = async () => {
  process.exit(1);
};
export default {
  name: 'probe/crash',
  category: 'probe',
  mountStrategy: 'subapp',
  actions: { misbehave },
  async register() {},
};
