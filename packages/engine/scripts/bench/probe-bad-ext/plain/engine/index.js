// @bun
// ADR 0062 probe: the plain collection's extension. `ping` answers, so a call proves it runs.
const ping = async () => ({ pong: true });
export default {
  name: "probe/plain",
  category: "probe",
  mountStrategy: "subapp",
  actions: { ping },
  async register() {},
};
