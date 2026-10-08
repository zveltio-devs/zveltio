// RFC extension-runner step 3b: one systemd instance per extension. The
// instance name must survive `RuntimeDirectory=zveltio-ext/%i` (an escaped
// name does not), stay unique per extension, and the files `setup` writes must
// be what the installer and the engine expect.
import { describe, expect, it } from 'bun:test';
import {
  runnerInstance,
  runnerSetupFiles,
  runnerSocketPath,
  runnerUnit,
} from '../../lib/ext-runner.js';

describe('runnerInstance', () => {
  it('is [a-z0-9_] only, whatever the extension name', () => {
    for (const name of ['acme/my-ext.v2', 'Ünïcode ext', '../../etc', 'a'.repeat(300)]) {
      expect(runnerInstance(name)).toMatch(/^[a-z0-9_]{1,60}$/);
    }
  });

  it('keeps names that reduce to the same text apart', () => {
    expect(runnerInstance('acme/x')).not.toBe(runnerInstance('acme_x'));
    expect(runnerInstance('acme/x')).toBe(runnerInstance('acme/x'));
  });

  it('names the unit and the socket after the instance', () => {
    const i = runnerInstance('acme/x');
    expect(runnerUnit('acme/x')).toBe(`zveltio-ext-runner@${i}.service`);
    expect(runnerSocketPath('acme/x')).toBe(`/run/zveltio-ext/${i}/runner.sock`);
  });
});

describe('runnerSetupFiles', () => {
  const files = runnerSetupFiles({ engineUser: 'zveltio', engineUid: 997, dir: '/opt/zveltio' });
  const unit = files['/etc/systemd/system/zveltio-ext-runner@.service'];

  it('runs each instance under its own uid, closed to the network, with the engine uid it serves', () => {
    expect(unit).toContain('DynamicUser=yes');
    expect(unit).toContain('IPAddressDeny=any');
    expect(unit).toContain('Environment=ZVELTIO_ENGINE_UID=997');
    expect(unit).toContain('BindReadOnlyPaths=/opt/zveltio/zveltio /opt/zveltio/extensions');
    // The socket the runner listens on is the one the engine connects to.
    expect(unit).toContain('Environment=ZVELTIO_EXT_RUNNER_SOCKET=/run/zveltio-ext/%i/runner.sock');
    expect(unit).toContain('RuntimeDirectory=zveltio-ext/%i');
  });

  it('switches the engine to the runner transport', () => {
    expect(files['/etc/systemd/system/zveltio.service.d/ext-runner.conf']).toContain(
      'Environment=ZVELTIO_EXT_TRANSPORT=runner',
    );
  });

  it('lets only the engine user manage only runner units', () => {
    const rule = files['/etc/polkit-1/rules.d/50-zveltio-ext-runner.rules'];
    expect(rule).toContain('subject.user === "zveltio"');
    expect(rule).toContain('unit.indexOf("zveltio-ext-runner@") === 0');
    expect(rule).not.toContain('"enable"');
  });
});
