import { createInterface } from 'readline';

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
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

export async function createGodCommand(opts: {
  url?: string;
  email?: string;
  name?: string;
}) {
  const engineUrl =
    opts.url || process.env.ENGINE_URL || 'http://localhost:3000';

  console.log('\n⚠️  SYSTEM RECOVERY OVERRIDE ACCOUNT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('This account bypasses ALL Casbin permissions.');
  console.log('EXCLUSIVE USE: disaster recovery when policies');
  console.log('Casbin are corrupted or admin access is blocked.');
  console.log('');
  console.log('Security recommendations:');
  console.log('  • Store credentials OFFLINE (not in cloud password manager)');
  console.log('  • Do not use this account for daily operations');
  console.log('  • Enable 2FA immediately after creation');
  console.log('  • Audit logins for this account separately');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const rlConfirm = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const confirmed = await prompt(
    rlConfirm,
    'I understand the risks. Create Recovery Override account? (yes/no): ',
  );
  rlConfirm.close();

  if (confirmed.trim().toLowerCase() !== 'yes') {
    console.log('Operation cancelled.');
    process.exit(0);
  }

  console.log(`\nCreating God (super-admin) user at ${engineUrl}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const email = opts.email || (await prompt(rl, 'Email: '));
    const name = opts.name || (await prompt(rl, 'Name: '));
    rl.close();

    const password = await promptHidden('Password: ');
    const confirmPassword = await promptHidden('Confirm password: ');

    if (password !== confirmPassword) {
      console.error('\n❌ Passwords do not match');
      process.exit(1);
    }

    // God accounts bypass ALL authorization — enforce a strong password policy.
    const pwErrors: string[] = [];
    if (password.length < 16)          pwErrors.push('at least 16 characters');
    if (!/[A-Z]/.test(password))        pwErrors.push('at least one uppercase letter');
    if (!/[a-z]/.test(password))        pwErrors.push('at least one lowercase letter');
    if (!/[0-9]/.test(password))        pwErrors.push('at least one digit');
    if (!/[^A-Za-z0-9]/.test(password)) pwErrors.push('at least one special character');
    if (pwErrors.length > 0) {
      console.error('\n❌ God account password is too weak. Required:');
      for (const e of pwErrors) console.error(`   • ${e}`);
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
      body: JSON.stringify({
        email: email.trim(),
        password,
        name: name.trim(),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const { user } = await res.json();

    // Grant admin permission via Casbin through a direct DB call
    // We use the engine's admin API (requires the engine to be running)
    console.log('🔑 Granting god permissions...');

    // First get a session token by signing in
    const loginRes = await fetch(`${engineUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });

    if (!loginRes.ok) {
      console.warn(
        '⚠️  Could not auto-grant admin role — grant manually via permissions API',
      );
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
      body: JSON.stringify({ userId: user.id, role: 'god' }),
    });

    if (permRes.ok) {
      console.log(`\n✅ God user created successfully!`);
      console.log(`   Email: ${email.trim()}`);
      console.log(`   Name:  ${name.trim()}`);
      console.log(`   Role:  god\n`);
      console.log(`👉 Log in at: ${engineUrl}/admin\n`);
    } else {
      console.log(`\n✅ User created: ${email.trim()}`);
      console.warn('⚠️  Could not auto-assign god role.');
      console.warn(
        '   Use the Permissions page in Studio to assign the admin role manually.\n',
      );
    }
  } catch (err: any) {
    rl.close();
    console.error(`\n❌ Failed to create god user: ${err.message}\n`);
    process.exit(1);
  }
}
