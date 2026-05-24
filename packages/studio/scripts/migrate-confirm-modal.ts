#!/usr/bin/env bun
/**
 * Replace window.confirm() with ConfirmModal via createExtensionConfirm().
 * Splits each handler into foo() → askConfirm + fooConfirmed() to preserve try/catch.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXT = join(import.meta.dir, '..', '../../../zveltio-extensions');

const IMPORT_CONFIRM =
  "import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';\n  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';";

const CONFIRM_INIT =
  '\n  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();\n';

const MODAL = `
<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>
`;

function walkPages(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkPages(p, out);
    else if (e.name === '+page.svelte') out.push(p);
  }
  return out;
}

function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractConfirmExpr(src: string, start: number): { expr: string; end: number } | null {
  const prefix = 'if (!confirm(';
  if (!src.slice(start).startsWith(prefix)) return null;
  let i = start + prefix.length;
  let depth = 0;
  const exprStart = i;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) {
        const expr = src.slice(exprStart, i).trim();
        if (!src.slice(i).startsWith(')) return;')) return null;
        return { expr, end: i + ')) return;'.length };
      }
      depth--;
    }
    i++;
  }
  return null;
}

type FnInfo = {
  start: number;
  end: number;
  bodyStart: number;
  name: string;
  isAsync: boolean;
  paramsText: string;
  callArgs: string;
};

function findInnermostFunction(src: string, pos: number): FnInfo | null {
  const re = /\b(async\s+)?function\s+(\w+)\s*\(/g;
  const candidates: FnInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const paramOpen = m.index + m[0].length - 1;
    let i = paramOpen + 1;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const braceOpen = src.indexOf('{', i);
    if (braceOpen === -1) continue;
    const braceClose = findMatchingBrace(src, braceOpen);
    if (braceClose === -1 || pos <= braceOpen || pos >= braceClose) continue;

    const paramsText = src.slice(paramOpen + 1, i - 1).trim();
    const callArgs = paramsText
      ? paramsText
          .split(',')
          .map((p) => {
            const m = p.trim().match(/^(\.\.\.)?([a-zA-Z_$][\w$]*)/);
            return m ? `${m[1] ?? ''}${m[2]}` : '';
          })
          .filter(Boolean)
          .join(', ')
      : '';

    candidates.push({
      start: m.index,
      end: braceClose,
      bodyStart: braceOpen + 1,
      name: m[2]!,
      isAsync: !!m[1],
      paramsText,
      callArgs,
    });
  }
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.end - a.start <= b.end - b.start ? a : b));
}

function ensureSetup(script: string): string {
  let s = script;
  if (!s.includes('createExtensionConfirm')) {
    if (s.includes("import { m } from '$lib/i18n.svelte.js';")) {
      s = s.replace("import { m } from '$lib/i18n.svelte.js';", `import { m } from '$lib/i18n.svelte.js';\n  ${IMPORT_CONFIRM}`);
    } else {
      s = s.replace('<script lang="ts">', `<script lang="ts">\n  import { m } from '$lib/i18n.svelte.js';\n  ${IMPORT_CONFIRM}`);
    }
    const insertAt = (() => {
      const markers = ['\n  type ', '\n  let ', '\n  const ', '\n  onMount', '\n  async function ', '\n  function '];
      let pos = -1;
      for (const mk of markers) {
        const i = s.indexOf(mk);
        if (i !== -1 && (pos === -1 || i < pos)) pos = i;
      }
      return pos === -1 ? s.length : pos;
    })();
    s = s.slice(0, insertAt) + CONFIRM_INIT + s.slice(insertAt);
  }
  return s;
}

function transform(script: string): { script: string; changed: boolean } {
  if (!script.includes('if (!confirm(') || script.includes('createExtensionConfirm')) {
    return { script, changed: false };
  }

  let s = ensureSetup(script);
  let changed = false;
  const indices: number[] = [];
  let search = 0;
  while ((search = s.indexOf('if (!confirm(', search)) !== -1) {
    indices.push(search);
    search += 1;
  }

  for (let i = indices.length - 1; i >= 0; i--) {
    const idx = indices[i]!;
    const parsed = extractConfirmExpr(s, idx);
    const fn = findInnermostFunction(s, idx);
    if (!parsed || !fn) continue;

    const { expr, end } = parsed;
    const before = s.slice(fn.bodyStart, idx);
    const after = s.slice(end, fn.end).trim();
    const confirmedName = `${fn.name}Confirmed`;

    const confirmedFn = `\n  ${fn.isAsync ? 'async ' : ''}function ${confirmedName}(${fn.paramsText}) {\n    ${after}\n  }\n`;

    const wrapper =
      `${fn.isAsync ? 'async ' : ''}function ${fn.name}(${fn.paramsText}) {` +
      `${before}    askConfirm(${expr}, () => ${confirmedName}(${fn.callArgs}));\n  }`;

    s = s.slice(0, fn.start) + wrapper + confirmedFn + s.slice(fn.end + 1);
    changed = true;
  }

  return { script: s, changed };
}

let updated = 0;
for (const page of walkPages(EXT)) {
  const full = readFileSync(page, 'utf8');
  if (!full.includes('if (!confirm(')) continue;

  const scriptEnd = full.indexOf('</script>');
  const { script, changed } = transform(full.slice(0, scriptEnd));
  if (!changed) continue;

  let out = script + full.slice(scriptEnd);
  if (!out.includes('<ConfirmModal')) {
    const shellClose = out.lastIndexOf('</ExtensionPageShell>');
    if (shellClose !== -1) {
      out = out.slice(0, shellClose) + MODAL + '\n' + out.slice(shellClose);
    } else {
      out = out.trimEnd() + '\n' + MODAL + '\n';
    }
  }

  writeFileSync(page, out);
  updated++;
  console.log('updated:', page.replace(/\\/g, '/').split('zveltio-extensions/')[1]);
}

console.log(`\n[migrate-confirm-modal] ${updated} pages updated`);
