#!/usr/bin/env bun
/**
 * Write the Studio's version into its build output.
 *
 * The engine serves `studio-dist/` as static files and had no way to tell
 * whether those files came from the same release. A dist built against an older
 * engine renders a blank page — the HTML loads, the JS calls an API shape that
 * no longer exists, and nothing anywhere says why. An audit hit exactly that and
 * spent its Studio testing on a black screen.
 *
 * A version file costs one line at build time and turns "blank page" into a
 * named cause at boot. It lives in the output rather than the manifest because
 * `manifest.json` is the PWA manifest, read by browsers, and adding private
 * fields to a spec'd document invites something to trip over them.
 */

import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const OUT = join(import.meta.dir, '..', 'dist', '.zveltio-studio-version');

await Bun.write(OUT, `${pkg.version}\n`);
console.log(`[stamp-version] studio dist marked ${pkg.version}`);
