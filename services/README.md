# Running the local infrastructure services

`dev-setup-starter` owns the local services that back development. All run as containers on the Docker Engine inside Ubuntu WSL2.

| Service | Role | Address |
| --- | --- | --- |
| Infisical | Secrets, certificates, and privileged access | `http://localhost:8088` |
| Portainer CE | Docker and Compose stack management | `https://localhost:9443` |
| DbGate | Database manager for SQL, NoSQL, and Redis | `http://localhost:3000` |

Each service publishes on the WSL2 NAT network. Windows reaches it through the WSL2 localhost forward, and the NAT network is not routable from the LAN, so the services stay local to this machine. Do not bind the published ports to `127.0.0.1`, because the WSL2 localhost forward only reaches ports that listen on all interfaces.

After a Windows or WSL restart, the forward can miss ports that Docker publishes during boot. If a service does not load at `localhost`, restart the containers so the forward picks them up:

```bash
docker restart infisical-backend portainer dbgate
```

## Prerequisites

1. Docker Engine runs in the WSL distro.
2. Your WSL user is in the `docker` group so the commands do not need `sudo`. If `docker info` fails, run the one-time step in [`../wsl/README.md`](../wsl/README.md) and start a new shell.
3. Windows reaches the services through the WSL2 localhost forward on their published ports.

## Infisical

Infisical is the single source of truth for secrets. It runs with PostgreSQL and Redis.

```bash
cd /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/services/infisical
cp .env.example .env
# Set ENCRYPTION_KEY and AUTH_SECRET before the first start. Without them the
# instance cannot decrypt secrets after a restart. See the file header.
# Change POSTGRES_PASSWORD from the example value before the first start.
docker compose up -d
```

Open `http://localhost:8088` and create the first account. The first user becomes the instance administrator.

Create one machine identity using Universal Auth and give it the Viewer role on the project. Its client ID and secret are the only secret-zero values; they live in the gitignored `settings/.env`. Keep them out of Git. See [`../docs/secrets.md`](../docs/secrets.md).

## Portainer CE

Portainer manages containers and Compose stacks through the Docker socket.

```bash
cd /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/services/portainer
docker compose up -d
```

Open `https://localhost:9443` and accept the self-signed certificate. A new instance asks for a setup token, which is printed in the container logs. Read it with:

```bash
docker logs portainer 2>&1 | grep setup_token
```

Create the administrator account within five minutes of reading the token. Portainer keeps its state in the `portainer_data` volume.

## DbGate

DbGate views and edits databases in a browser. It supports SQL engines (PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, SQLite, CockroachDB, ClickHouse, Firebird), NoSQL (MongoDB, Apache Cassandra), and Redis.

```bash
cd /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/services/dbgate
docker compose up -d
```

Open `http://localhost:3000` and add a connection. DbGate keeps its saved connections and scripts in the `dbgate_data` volume, so they survive a container recreate.

DbGate runs on the Docker engine and can only reach a database on the same network or published on the host. To inspect the Infisical PostgreSQL, attach DbGate to the Infisical network, then connect to host `db` on port `5432` with the credentials from `services/infisical/.env`:

```bash
docker network connect infisical_infisical dbgate
```

## Backups

The Infisical `pg_data` volume holds every encrypted secret. Without the Infisical `ENCRYPTION_KEY`, a restored database cannot be decrypted. Back up the volume and keep the key separately. The `portainer_data` and `dbgate_data` volumes hold tool state that is cheap to recreate, but back them up if the saved DbGate connections are worth keeping.

## Secrets

No secret is committed. `services/*/.env` is gitignored, and only the `*.env.example` files are tracked. The Infisical instance's own bootstrap secrets and database password live in its `.env`, which is also gitignored.
