export async function sendViaVonage(opts: {
  apiKey: string;
  apiSecret: string;
  from: string;
  to: string;
  text: string;
}): Promise<{ messageId: string; status: string }> {
  const url = 'https://rest.nexmo.com/sms/json';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: opts.apiKey,
      api_secret: opts.apiSecret,
      from: opts.from,
      to: opts.to,
      text: opts.text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vonage error ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    messages: Array<{ 'message-id': string; status: string; 'error-text'?: string }>;
  };

  const msg = data.messages?.[0];
  if (!msg) throw new Error('Vonage returned no message');

  if (msg.status !== '0') {
    throw new Error(`Vonage delivery error status ${msg.status}: ${msg['error-text'] ?? 'unknown'}`);
  }

  return { messageId: msg['message-id'], status: 'sent' };
}
