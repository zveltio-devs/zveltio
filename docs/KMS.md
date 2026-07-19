# External key management (KMS)

By default the installer generates Zveltio's secrets (`FIELD_ENCRYPTION_KEY`,
`MAIL_ENCRYPTION_KEY`, `AI_KEY_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, …) and
stores them in `/opt/zveltio/.env`. Organizations that must keep keys in a KMS
can source them at boot instead — **without any engine code involvement**.

## How it works

Set `ZVELTIO_KEY_COMMAND` in `/opt/zveltio/.env` to any command that prints
`KEY=VALUE` lines on stdout. The systemd unit runs it (`ExecStartPre`, as the
`zveltio` user) right before every start; the output is written to
`/opt/zveltio/.env.kms` (mode 600) and loaded on top of `.env` — values from
the KMS **override** the same keys in `.env`, so you can delete the sensitive
lines from `.env` entirely once the KMS is authoritative.

Fail-closed semantics: if `ZVELTIO_KEY_COMMAND` is set but the command fails
or produces no `KEY=VALUE` lines, **the service refuses to start**. Zveltio
never boots with missing encryption keys. Unset means a complete no-op (the
default installer behaviour is unchanged).

## Examples

HashiCorp Vault (KV v2):

```bash
ZVELTIO_KEY_COMMAND="vault kv get -format=json secret/zveltio | jq -r '.data.data | to_entries[] | \"\(.key)=\(.value)\"'"
```

AWS Secrets Manager:

```bash
ZVELTIO_KEY_COMMAND="aws secretsmanager get-secret-value --secret-id zveltio/prod --query SecretString --output text | jq -r 'to_entries[] | \"\(.key)=\(.value)\"'"
```

SOPS-encrypted dotenv file:

```bash
ZVELTIO_KEY_COMMAND="sops -d /opt/zveltio/secrets.enc.env"
```

## Notes

- The command runs as the `zveltio` service user — grant that identity (IAM
  role, Vault AppRole, age key) read access to the secret, nothing else.
- `.env.kms` is transient state; it is rewritten on every start and removed
  when `ZVELTIO_KEY_COMMAND` is unset. Do not edit it by hand.
- Key **rotation**: rotate in the KMS, then `systemctl restart zveltio`.
  (Re-encrypting existing data after a `FIELD_ENCRYPTION_KEY` rotation is a
  separate, documented operation — the old key must remain available until
  re-encryption completes.)
