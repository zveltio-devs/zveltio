# Scaling Zveltio Horizontally (High Availability)

Zveltio is designed with a cloud-native, stateless architecture, allowing it to easily scale horizontally to meet enterprise-grade traffic and high-availability (HA) requirements. 

## Architectural Overview

The default Zveltio deployment includes all the necessary components for horizontal scaling out-of-the-box:

1. **Application State (Stateless Engine):** The Zveltio engine holds no localized state. You can spin up as many instances of the engine as you need.
2. **Database & Connection Pooling:** PostgreSQL (with pgvector) handles all relational data. Crucially, Zveltio includes **PgBouncer** by default, allowing hundreds of engine instances to connect without overwhelming the database with connection limits.
3. **Session, Caching & Realtime:** **Valkey** acts as the central session store, caching layer, and Pub/Sub message broker. When a database event occurs on Engine A, it broadcasts via Valkey so Engine B and C can sync their connected WebSocket clients in realtime.
4. **File Storage:** Zveltio uses **SeaweedFS** (S3-compatible) to ensure all scaled engine instances serve and store the exact same assets, bypassing localized disk constraints.

---

## Scaling with Docker Compose (Multi-node / Replicas)

Because the state is already externalized to Valkey and SeaweedFS in your default `docker-compose.yml`, scaling the engine horizontally is as simple as adding a load balancer and increasing the replica count.

### 1. Add a Load Balancer (e.g., Nginx or Traefik)
Create an `nginx.conf` to balance traffic across your engine replicas and handle WebSocket upgrades:

```nginx
events { worker_connections 1024; }

http {
    upstream zveltio_engine {
        # Docker's internal DNS will automatically round-robin traffic 
        # across all replicas of the 'engine' service.
        server engine:3000;
    }

    server {
        listen 80;

        # Standard REST API, GraphQL & Admin Panel traffic
        location / {
            proxy_pass http://zveltio_engine;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        # WebSocket support for Realtime Sync
        location /api/ws {
            proxy_pass http://zveltio_engine;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "Upgrade";
            proxy_set_header Host $host;
            proxy_read_timeout 86400; 
        }
    }
}