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

export async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);

    const stdin = process.stdin;
    const wasPaused = stdin.isPaused();
    if (wasPaused) stdin.resume();

    let value = '';
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');

    const handler = (char: string) => {
      if (char === '\n' || char === '\r' || char === '\u0003') {
        if (char === '\u0003') process.exit(1);
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.off('data', handler);
        process.stdout.write('\n');
        resolve(value);
      } else if (char === '\u007f') {
        // Backspace
        if (value.length > 0) value = value.slice(0, -1);
      } else {
        value += char;
        process.stdout.write('*');
      }
    };

    stdin.on('data', handler);
  });
}
