// @bun
// ADR 0062 fail-alone probe. One action that misbehaves on purpose.
const keep = [];
const misbehave = async () => {
  while (true) {}
};
export default {
  name: "probe/loop",
  category: "probe",
  mountStrategy: "subapp",
  actions: { misbehave },
  async register() {},
};
