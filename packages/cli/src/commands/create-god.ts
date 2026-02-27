import { createInterface } from 'readline';

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function promptHidden(question: string): Promise<string> {
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

export async function createGodCommand(opts: { url?: string; email?: string; name?: string }) {
  const engineUrl = opts.url || process.env.ENGINE_URL || 'http://localhost:3000';

  console.log(`\nCreating God (super-admin) user at ${engineUrl}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const email = opts.email || await prompt(rl, 'Email: ');
    const name = opts.name || await prompt(rl, 'Name: ');
    rl.close();

    const password = await promptHidden('Password: ');
    const confirmPassword = await promptHidden('Confirm password: ');

    if (password !== confirmPassword) {
      console.error('\n❌ Passwords do not match');
      process.exit(1);
    }

    if (password.length < 8) {
      console.error('\n❌ Password must be at least 8 characters');
      process.exit(1);
    }

    if (!email.includes('@')) {
      console.error('\n❌ Invalid email address');
      process.exit(1);
    }

    console.log('\n🔄 Creating god user...');

    // Register via Better-Auth sign-up endpoint
    const res = await fetch(`${engineUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password, name: name.trim() }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const { user } = await res.json();

    // Grant admin permission via Casbin through a direct DB call
    // We use the engine's admin API (requires the engine to be running)
    console.log('🔑 Granting admin permissions...');

    // First get a session token by signing in
    const loginRes = await fetch(`${engineUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });

    if (!loginRes.ok) {
      console.warn('⚠️  Could not auto-grant admin role — grant manually via permissions API');
      console.log(`\n✅ User created: ${email}\n`);
      return;
    }

    const sessionCookie = loginRes.headers.get('set-cookie') || '';

    // Grant admin role
    const permRes = await fetch(`${engineUrl}/api/permissions/assign-role`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ userId: user.id, role: 'admin' }),
    });

    if (permRes.ok) {
      console.log(`\n✅ God user created successfully!`);
      console.log(`   Email: ${email.trim()}`);
      console.log(`   Name:  ${name.trim()}`);
      console.log(`   Role:  admin\n`);
      console.log(`👉 Log in at: ${engineUrl}/admin\n`);
    } else {
      console.log(`\n✅ User created: ${email.trim()}`);
      console.warn('⚠️  Could not auto-assign admin role.');
      console.warn('   Use the Permissions page in Studio to assign the admin role manually.\n');
    }
  } catch (err: any) {
    rl.close();
    console.error(`\n❌ Failed to create god user: ${err.message}\n`);
    process.exit(1);
  }
}
