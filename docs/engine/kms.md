# External key management (KMS)

By default the installer generates Zveltio's secrets (`FIELD_ENCRYPTION_KEY`,
`MAIL_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, …) and
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
- Key **rotation**: `BETTER_AUTH_SECRET` rotates through `BETTER_AUTH_SECRETS`
  ([security.md](../platform/security.md#rotating-better_auth_secret)).
  `FIELD_ENCRYPTION_KEY` and `MAIL_ENCRYPTION_KEY` rotate through
  `FIELD_ENCRYPTION_KEYS` / `MAIL_ENCRYPTION_KEYS`, comma lists whose first key
  is current and every key reads (ADR 0059,
  [security.md](../platform/security.md#rotating-field_encryption_key-and-mail_encryption_key)).
  Emit the list from the KMS and keep the old key in it: a key left out leaves
  every value written under it unreadable (an encrypted field reads back as its
  ciphertext, a mail password fails to decrypt). `zveltio rotate-keys`
  rewrites the engine's field values under the current key, reseals what
  extensions sealed under the current field or mail key, and reports what is
  left under each key id; drop an old key only once nothing is
  ([security.md](../platform/security.md#zveltio-rotate-keys)).
