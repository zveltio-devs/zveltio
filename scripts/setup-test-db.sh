#!/usr/bin/env bash
# One-shot: install Postgres 18 + pgvector and create the harness test DB
# matching CI's TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zveltio_test
# Idempotent — safe to re-run. Requires sudo (you'll be asked for your password).
set -euo pipefail

echo ">> apt install postgresql-18 + pgvector ..."
sudo apt update
sudo apt install -y postgresql-18 postgresql-18-pgvector

echo ">> starting the cluster ..."
sudo systemctl start postgresql 2>/dev/null || sudo pg_ctlcluster 18 main start || true
# wait for socket
for i in $(seq 1 20); do
  sudo -u postgres pg_isready >/dev/null 2>&1 && break
  sleep 0.5
done

echo ">> setting postgres password + creating zveltio_test ..."
sudo -u postgres psql -qc "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='zveltio_test'" | grep -q 1 \
  || sudo -u postgres createdb zveltio_test
sudo -u postgres psql -d zveltio_test -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
sudo -u postgres psql -d zveltio_test -qc "CREATE EXTENSION IF NOT EXISTS vector;"

echo ">> verifying TCP password auth (what the harness uses) ..."
PGPASSWORD=postgres psql "postgresql://postgres:postgres@localhost:5432/zveltio_test" -tAc "SELECT 'DB_OK ' || version();"

echo ""
echo "DONE — test DB ready at postgresql://postgres:postgres@localhost:5432/zveltio_test"
