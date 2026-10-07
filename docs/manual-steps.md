# Manual steps

These require interactive input or elevation and are not automated. Run them when you are ready.

## 1. Docker group access

Done on this machine. The WSL user is in the `docker` group, so `docker` runs without `sudo`. On a new machine, run this once and start a new shell.

```bash
sudo usermod -aG docker "$USER"
# start a new shell, then:
docker run --rm hello-world
```

## 2. Start the local services

Done on this machine. The four containers run on the WSL Docker Engine. On a new machine:

```bash
cd /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/services/infisical
cp .env.example .env
openssl rand -hex 16   # paste into ENCRYPTION_KEY
openssl rand -base64 32 # paste into AUTH_SECRET
docker compose up -d
```

Then open `http://localhost:8088` and create the admin account, and follow [`secrets.md`](secrets.md) to create the project and the machine identity. See [`../services/README.md`](../services/README.md).

```bash
cd /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/services/portainer
docker compose up -d
cd /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/services/dbgate
docker compose up -d
```

Portainer's first run asks for a setup token. Read it with `docker logs portainer 2>&1 | grep setup_token`, then open `https://localhost:9443`. The token expires five minutes after the container starts, so restart Portainer with `docker restart portainer` if it times out. DbGate is at `http://localhost:3000`.

## 3. Register the commit signing keys with GitHub

Signed commits are required on `main`. Two signing keys were generated, one per runtime:

- Windows: `%USERPROFILE%\.ssh\id_ed25519_signing.pub`
- WSL: `~/.ssh/id_ed25519_signing.pub`

Register both as signing keys. The `gh` token lacks the `admin:ssh_signing_key` scope, so either refresh it or add the keys in the GitHub UI under Settings, SSH and GPG keys, New SSH key, with key type set to Signing Key.

```bash
gh auth refresh -h github.com -s admin:ssh_signing_key
gh ssh-key add ~/.ssh/id_ed25519_signing.pub --type signing --title "wsl signing"
```

## 4. Confirm the workspace after the Docker step

The workspace default MCP set is empty, so there is nothing to connect. Verify the CLI owners instead, using the `service-integrations` registry:

```bash
gh auth status
postman whoami
discli server list
```

On Windows, `pwsh -File scripts\Import-Secrets.ps1` audits the secrets the loaders would set.

## 5. Refresh the token for organization rulesets (later)

Organization-wide rulesets and the org protection audit need the `admin:org` scope. Per-repository rulesets work once a repository is public.

```bash
gh auth refresh -h github.com -s admin:org
```

## 6. Enroll the Agent Vault proxy and create the identities

Done on this machine. On a new machine:

1. Enroll the proxy once. The enrollment token is spent after the first start,
   so keep it off the process arguments and off any committed file.

   ```bash
   infisical agent-vault proxy --domain http://localhost:8088 --port 17323 \
     --enrollment-token <token>
   ```

   The systemd user unit `~/.config/systemd/user/agent-vault-proxy.service` then
   starts the proxy without the token and restarts it on failure. Enable linger
   so it survives logout.

2. In the Infisical UI, create two machine identities in Agent Vault with
   Universal Auth, one per role: `Agent-Vault-Runner` and `Human-Vault-Runner`.
   Neither belongs to a project, because Agent Vault rejects an identity that
   already belongs to another project.

3. Grant both identities the `discord` and `postman` bundles.

4. Write the role configs at mode `0600`: `~/.config/agent-vault/env` for the
   agent and `~/.config/agent-vault/human.env` for the human. Each holds the
   proxy address, the vault identity client id, and the client secret.

5. Install the wrappers from `scripts/agent-vault/`: `with-vault` and
   `with-secrets` to `~/.local/bin`, and `with-vault.ps1`, `with-secrets.ps1`,
   and `shim/sitecustomize.py` under the Windows config directory. See
   [`secrets.md`](secrets.md).
