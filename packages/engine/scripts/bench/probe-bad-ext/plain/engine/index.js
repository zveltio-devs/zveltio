// @bun
// ADR 0062 fail-alone probe. One action that misbehaves on purpose.
const keep = [];
const misbehave = async () => {

};
export default {
  name: "probe/plain",
  category: "probe",
  mountStrategy: "subapp",
  actions: {},
  async register() {},
};
