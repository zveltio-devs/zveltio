export async function sendViaTwilio(opts: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string; status: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`;

  const credentials = btoa(`${opts.accountSid}:${opts.authToken}`);

  const formBody = new URLSearchParams({
    From: opts.from,
    To: opts.to,
    Body: opts.body,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twilio error ${res.status}: ${errText}`);
  }

  const data = await res.json() as { sid: string; status: string };
  return { sid: data.sid, status: data.status };
}
