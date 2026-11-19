/** Terminal prompts shared by the commands that ask a person for input. */
import type { createInterface } from 'readline';

export async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

/**
 * What a pipe delivered past the line one prompt took: piped input arrives as one
 * chunk, and `create-god` asks twice (password, confirmation).
 */
let pending = '';

/**
 * Read one line without echoing it: typed in a terminal, or piped
 * (`printf 'pw\npw\n' | zveltio create-god …`). Rejects when input ends first.
 */
export function promptHidden(question: string): Promise<string> {
  return readLine(question, true);
}

/** Read one visible line, from the same buffer as `promptHidden`, so the two can alternate on a pipe. */
export function promptLine(question: string): Promise<string> {
  return readLine(question, false);
}

async function readLine(question: string, hidden: boolean): Promise<string> {
  process.stdout.write(question);
  const queued = takeLine();
  if (queued !== null) {
    process.stdout.write('\n');
    return queued;
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    // A last line with no newline after it (`printf 'pw\npw'`) is the start of this value.
    let value = pending;
    pending = '';
    const done = (finish: () => void) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off('data', handler);
      stdin.off('end', ended);
      process.stdout.write('\n');
      finish();
    };
    // A chunk is a keystroke when typed, but a whole line (or several) when pasted or piped.
    const handler = (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i]!;
        if (char === '\u0003') process.exit(1);
        if (char === '\n' || char === '\r') {
          // `\r\n` from a pipe ends one line, not two.
          const next = char === '\r' && chunk[i + 1] === '\n' ? i + 2 : i + 1;
          pending = chunk.slice(next);
          done(() => resolve(value));
          return;
        }
        if (char === '\u007f') {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (stdin.isTTY) process.stdout.write('\b \b');
          }
        } else {
          value += char;
          if (stdin.isTTY) process.stdout.write(hidden ? '*' : char);
        }
      }
    };
    const ended = () =>
      done(() =>
        value ? resolve(value) : reject(new Error('input ended before a value was given')),
      );
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');
    stdin.on('data', handler);
    stdin.once('end', ended);
    stdin.resume();
  });
}

function takeLine(): string | null {
  const m = /\r?\n|\r/.exec(pending);
  if (!m) return null;
  const line = pending.slice(0, m.index);
  pending = pending.slice(m.index + m[0].length);
  return line;
}
