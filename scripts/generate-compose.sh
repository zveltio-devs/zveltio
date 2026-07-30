#!/usr/bin/env bash
# Generează toate variantele de docker-compose pentru o versiune dată
# Usage: ./scripts/generate-compose.sh 2.0.1 ./output/

set -euo pipefail

VERSION="${1:?Usage: $0 <version> <output_dir>}"
OUTPUT_DIR="${2:?Usage: $0 <version> <output_dir>}"
REGISTRY="ghcr.io/zveltio-devs/zveltio-engine"
IMAGE="${REGISTRY}:${VERSION}"

mkdir -p "$OUTPUT_DIR"

# ── docker-compose.yml (Full Stack) ───────────────────────────
cat > "${OUTPUT_DIR}/docker-compose.yml" << EOF
# Zveltio ${VERSION} — Full Stack
# Includes: Engine, Studio, Client, PostgreSQL, PgDog, Valkey, SeaweedFS
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# Quick start:
#   curl -fsSL https://get.zveltio.com/releases/${VERSION}/.env.example -o .env
#   # Edit .env with your credentials
#   docker compose up -d


services:
  postgres:
    image: pgvector/pgvector:pg18
    container_name: zveltio-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-zveltio}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: \${POSTGRES_DB:-zveltio}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-zveltio}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - zveltio

  pgdog-init:
    image: alpine:3.19
    container_name: zveltio-pgdog-init
    environment:
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: \${POSTGRES_DB:-zveltio}
      DB_USER: \${POSTGRES_USER:-zveltio}
      DB_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - pgdog_config:/pgdog
    command:
      - /bin/sh
      - -c
      - |
        printf '[general]\\nhost = "0.0.0.0"\\nport = 6432\\ndefault_pool_size = 20\\nmin_pool_size = 5\\npooler_mode = "session"\\nauth_type = "scram"\\n\\n[[databases]]\\nname = "%s"\\nhost = "%s"\\nport = %s\\n' \\
          "\$\$DB_NAME" "\$\$DB_HOST" "\$\$DB_PORT" > /pgdog/pgdog.toml
        printf '[[users]]\\nname = "%s"\\ndatabase = "%s"\\npassword = "%s"\\n' \\
          "\$\$DB_USER" "\$\$DB_NAME" "\$\$DB_PASSWORD" > /pgdog/users.toml
    restart: "no"
    networks:
      - zveltio

  pgdog:
    image: ghcr.io/pgdogdev/pgdog:v0.1.33
    container_name: zveltio-pgdog
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      pgdog-init:
        condition: service_completed_successfully
    volumes:
      - pgdog_config:/pgdog
    networks:
      - zveltio

  valkey:
    image: valkey/valkey:8-alpine
    container_name: zveltio-valkey
    restart: unless-stopped
    # Password-protected even though this instance is only reachable on the
    # internal compose network — a compromised sibling container should not
    # inherit read/write on sessions and rate-limit state.
    command: valkey-server --requirepass \${VALKEY_PASSWORD} --save 60 1 --loglevel warning
    volumes:
      - valkey_data:/data
    healthcheck:
      test: ["CMD", "valkey-cli", "-a", "\${VALKEY_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - zveltio

  seaweedfs-master:
    image: chrislusf/seaweedfs:3.68
    container_name: zveltio-seaweedfs-master
    restart: unless-stopped
    command: master -mdir=/data -defaultReplication=000
    volumes:
      - seaweedfs_master:/data
    networks:
      - zveltio

  seaweedfs-volume:
    image: chrislusf/seaweedfs:3.68
    container_name: zveltio-seaweedfs-volume
    restart: unless-stopped
    command: volume -dir=/data -max=10 -mserver=seaweedfs-master:9333 -port=8080
    volumes:
      - seaweedfs_volume:/data
    depends_on:
      - seaweedfs-master
    networks:
      - zveltio

  # Renders the SeaweedFS S3 identity file from the environment. It cannot be
  # shipped as a static file with \${VARS} inside: SeaweedFS does not expand
  # environment variables in its JSON config, so a placeholder file grants
  # access to nobody and operators "fix" it by pasting real keys into a
  # versioned file. Compose expands the values below into S3_CONFIG_JSON; the
  # doubled \$\$ keeps the shell from touching it.
  seaweedfs-init:
    image: alpine:3.20
    container_name: zveltio-seaweedfs-init
    environment:
      S3_CONFIG_JSON: '{"identities":[{"name":"zveltio-engine","credentials":[{"accessKey":"\${S3_ACCESS_KEY:?Set S3_ACCESS_KEY in .env}","secretKey":"\${S3_SECRET_KEY:?Set S3_SECRET_KEY in .env}"}],"actions":["Read:zveltio","Write:zveltio","List:zveltio","Tagging:zveltio","Admin:zveltio"]}]}'
    command: ["sh", "-c", "printf '%s' \"\$\$S3_CONFIG_JSON\" > /config/s3-config.json"]
    volumes:
      - seaweedfs_config:/config

  seaweedfs-filer:
    image: chrislusf/seaweedfs:3.68
    container_name: zveltio-seaweedfs-filer
    restart: unless-stopped
    # -s3.config is what turns on authentication. Without it the filer serves
    # anonymous read/write/delete on the S3 port — which was published on
    # 0.0.0.0. Bound to loopback for the same reason as Valkey above.
    command: filer -master=seaweedfs-master:9333 -s3 -s3.config=/config/s3-config.json
    ports:
      - "127.0.0.1:\${S3_PORT:-8333}:8333"
    volumes:
      - seaweedfs_config:/config:ro
    depends_on:
      seaweedfs-volume:
        condition: service_started
      seaweedfs-init:
        condition: service_completed_successfully
    networks:
      - zveltio

  engine:
    image: ${IMAGE}
    container_name: zveltio-engine
    restart: unless-stopped
    ports:
      - "\${PORT:-3000}:3000"
    environment:
      DATABASE_URL: postgres://\${POSTGRES_USER:-zveltio}:\${POSTGRES_PASSWORD}@pgdog:6432/\${POSTGRES_DB:-zveltio}
      VALKEY_URL: redis://:\${VALKEY_PASSWORD}@valkey:6379
      S3_ENDPOINT: http://seaweedfs-filer:8333
      S3_ACCESS_KEY: \${S3_ACCESS_KEY:-zveltio}
      S3_SECRET_KEY: \${S3_SECRET_KEY:?Set S3_SECRET_KEY in .env}
      S3_BUCKET: \${S3_BUCKET:-zveltio}
      PORT: 3000
      NODE_ENV: production
      SECRET_KEY: \${SECRET_KEY:?Set SECRET_KEY in .env}
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET in .env}
      CORS_ORIGINS: \${CORS_ORIGINS:-}
      MAIL_ENCRYPTION_KEY: \${MAIL_ENCRYPTION_KEY:-}
      AI_KEY_ENCRYPTION_KEY: \${AI_KEY_ENCRYPTION_KEY:-}
      ZVELTIO_VERSION: ${VERSION}
      ZVELTIO_EXTENSIONS: \${ZVELTIO_EXTENSIONS:-ai,workflow/approvals,workflow/checklists,content/page-builder,developer/edge-functions,developer/graphql,data/export,data/import,i18n/translations,crm,communications/mail}
    depends_on:
      postgres:
        condition: service_healthy
      valkey:
        condition: service_healthy
      pgdog:
        condition: service_started
      seaweedfs-filer:
        condition: service_started
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    networks:
      - zveltio

volumes:
  postgres_data:
  valkey_data:
  seaweedfs_master:
  seaweedfs_volume:
  seaweedfs_config:
  pgdog_config:

networks:
  zveltio:
    name: zveltio-network
EOF

# ── docker-compose.infra.yml (Infrastructure Only) ────────────
cat > "${OUTPUT_DIR}/docker-compose.infra.yml" << EOF
# Zveltio ${VERSION} — Infrastructure Only
# Use this when running the engine natively with Bun
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# Quick start:
#   docker compose -f docker-compose.infra.yml up -d
#   zveltio start


services:
  postgres:
    image: pgvector/pgvector:pg18
    container_name: zveltio-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-zveltio}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: \${POSTGRES_DB:-zveltio}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    # Loopback only. infra mode runs the engine natively on this host, so the
    # port has to be published — but publishing it on 0.0.0.0 put the database
    # itself on the public internet, protected by nothing but the password.
    ports:
      - "127.0.0.1:\${POSTGRES_PORT:-5432}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-zveltio}"]
      interval: 10s
      timeout: 5s
      retries: 5

  valkey:
    image: valkey/valkey:8-alpine
    container_name: zveltio-valkey
    restart: unless-stopped
    # --requirepass is mandatory, and the port binds to loopback only. Without
    # both, a native install published an unauthenticated Valkey on 0.0.0.0 —
    # anyone who could reach the host could read sessions and rate-limit state.
    # The engine runs on the host in native mode, so the port must stay
    # published; 127.0.0.1 keeps it reachable there and nowhere else.
    command: valkey-server --requirepass \${VALKEY_PASSWORD} --save 60 1 --loglevel warning
    volumes:
      - valkey_data:/data
    ports:
      - "127.0.0.1:\${VALKEY_PORT:-6379}:6379"
    healthcheck:
      test: ["CMD", "valkey-cli", "-a", "\${VALKEY_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  seaweedfs-master:
    image: chrislusf/seaweedfs:3.68
    container_name: zveltio-seaweedfs-master
    restart: unless-stopped
    command: master -mdir=/data -defaultReplication=000
    volumes:
      - seaweedfs_master:/data

  seaweedfs-volume:
    image: chrislusf/seaweedfs:3.68
    container_name: zveltio-seaweedfs-volume
    restart: unless-stopped
    command: volume -dir=/data -max=10 -mserver=seaweedfs-master:9333 -port=8080
    volumes:
      - seaweedfs_volume:/data
    depends_on:
      - seaweedfs-master

  # Renders the SeaweedFS S3 identity file from the environment. It cannot be
  # shipped as a static file with \${VARS} inside: SeaweedFS does not expand
  # environment variables in its JSON config, so a placeholder file grants
  # access to nobody and operators "fix" it by pasting real keys into a
  # versioned file. Compose expands the values below into S3_CONFIG_JSON; the
  # doubled \$\$ keeps the shell from touching it.
  seaweedfs-init:
    image: alpine:3.20
    container_name: zveltio-seaweedfs-init
    environment:
      S3_CONFIG_JSON: '{"identities":[{"name":"zveltio-engine","credentials":[{"accessKey":"\${S3_ACCESS_KEY:?Set S3_ACCESS_KEY in .env}","secretKey":"\${S3_SECRET_KEY:?Set S3_SECRET_KEY in .env}"}],"actions":["Read:zveltio","Write:zveltio","List:zveltio","Tagging:zveltio","Admin:zveltio"]}]}'
    command: ["sh", "-c", "printf '%s' \"\$\$S3_CONFIG_JSON\" > /config/s3-config.json"]
    volumes:
      - seaweedfs_config:/config

  seaweedfs-filer:
    image: chrislusf/seaweedfs:3.68
    container_name: zveltio-seaweedfs-filer
    restart: unless-stopped
    # -s3.config is what turns on authentication. Without it the filer serves
    # anonymous read/write/delete on the S3 port — which was published on
    # 0.0.0.0. Bound to loopback for the same reason as Valkey above.
    command: filer -master=seaweedfs-master:9333 -s3 -s3.config=/config/s3-config.json
    ports:
      - "127.0.0.1:\${S3_PORT:-8333}:8333"
    volumes:
      - seaweedfs_config:/config:ro
    depends_on:
      seaweedfs-volume:
        condition: service_started
      seaweedfs-init:
        condition: service_completed_successfully

volumes:
  postgres_data:
  valkey_data:
  seaweedfs_master:
  seaweedfs_volume:
  seaweedfs_config:
EOF

# ── docker-compose.engine.yml (Engine Only) ───────────────────
cat > "${OUTPUT_DIR}/docker-compose.engine.yml" << EOF
# Zveltio ${VERSION} — Engine Only
# Use this when you have your own PostgreSQL, Redis, and S3
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# Prerequisites: set DATABASE_URL, VALKEY_URL, S3_ENDPOINT in .env


services:
  engine:
    image: ${IMAGE}
    container_name: zveltio-engine
    restart: unless-stopped
    ports:
      - "\${PORT:-3000}:3000"
    environment:
      DATABASE_URL: \${DATABASE_URL:?Set DATABASE_URL in .env}
      VALKEY_URL: \${VALKEY_URL:?Set VALKEY_URL in .env}
      S3_ENDPOINT: \${S3_ENDPOINT:?Set S3_ENDPOINT in .env}
      S3_ACCESS_KEY: \${S3_ACCESS_KEY}
      S3_SECRET_KEY: \${S3_SECRET_KEY}
      S3_BUCKET: \${S3_BUCKET:-zveltio}
      PORT: 3000
      NODE_ENV: production
      SECRET_KEY: \${SECRET_KEY:?Set SECRET_KEY in .env}
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET in .env}
      CORS_ORIGINS: \${CORS_ORIGINS:-}
      MAIL_ENCRYPTION_KEY: \${MAIL_ENCRYPTION_KEY:-}
      AI_KEY_ENCRYPTION_KEY: \${AI_KEY_ENCRYPTION_KEY:-}
      ZVELTIO_VERSION: ${VERSION}
      ZVELTIO_EXTENSIONS: \${ZVELTIO_EXTENSIONS:-ai,workflow/approvals,workflow/checklists,content/page-builder,developer/edge-functions,developer/graphql,data/export,data/import,i18n/translations,crm,communications/mail}
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
EOF

echo "✅ Generated compose files in ${OUTPUT_DIR}"
