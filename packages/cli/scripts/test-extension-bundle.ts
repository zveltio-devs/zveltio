#!/usr/bin/env bun
/** Quick smoke: bundle CRM engine with the zveltio extension-bundle plugin. */
import { resolve } from 'node:path';
import { bundleExtensionEngine } from '../src/lib/extension-bundle.ts';

const crm = resolve(import.meta.dir, '../../../../zveltio-extensions/crm');
const entry = resolve(crm, 'engine/index.ts');
const outfile = resolve(crm, 'engine/index.js');

await bundleExtensionEngine({
  entry,
  outfile,
  external: [],
  resolveDir: crm,
});

console.log('OK:', outfile, (await Bun.file(outfile).arrayBuffer()).byteLength, 'bytes');
