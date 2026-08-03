# EC2 ARM64 production bootstrap

This procedure creates a parallel Amazon Linux 2023 `t4g.micro` environment.
It intentionally does not create an application database, database role, schema,
or application data.

## 1. Bootstrap the operating system

From the local project directory, stream the versioned bootstrap script to the
new instance. Replace `cwa24-arm` with the SSH alias for the temporary instance.

```bash
ssh cwa24-arm 'sudo bash -s' < ops/bootstrap-amazon-linux-2023-arm64.sh
```

The script installs the production-compatible stack:

- expansion of the root partition and filesystem to the available EBS size;
- official Node.js 26.4.0 ARM64 distribution;
- PM2 6.0.14;
- PostgreSQL 15;
- Valkey, exposed only through the local default service configuration;
- Nginx and Certbot;
- build tools required by npm packages;
- a persistent 2 GiB swap file.

It also initializes the empty PostgreSQL cluster and enables SCRAM password
authentication for local TCP connections. It does not execute SQL.

Verify the result:

```bash
ssh cwa24-arm
uname -m
node --version
npm --version
pm2 --version
psql --version
sudo systemctl is-active postgresql valkey nginx
free -h
```

Expected architecture: `aarch64`.

## 2. Install the application

Clone the repository using the same Git credentials as the existing production
instance.

```bash
git clone https://github.com/D025449/woa.git /home/ec2-user/woa
cd /home/ec2-user/woa
npm ci --omit=dev
mkdir -p tmp
```

Do not copy `node_modules` from the x86 instance. Dependencies must be installed
natively on ARM64.

Transfer `.env.production` separately and restrict its permissions:

```bash
chmod 600 /home/ec2-user/woa/.env.production
```

Do not put secrets into EC2 User Data or commit them to Git.

## 3. Create the PostgreSQL role and database manually

Open an interactive PostgreSQL session:

```bash
sudo -u postgres psql
```

Run the following statements yourself, substituting the exact credentials from
`.env.production`:

```sql
CREATE ROLE <DB_USER> WITH LOGIN PASSWORD '<DB_PASSWORD>';
CREATE DATABASE <DB_NAME> OWNER <DB_USER>;
\q
```

Angle-bracket values are placeholders and must not be entered literally. Test
the password-based local connection without placing the password in shell
history:

```bash
psql -h 127.0.0.1 -U <DB_USER> -d <DB_NAME> -W \
  -c 'SELECT current_database(), current_user;'
```

## 4. Build the empty application schema manually

Only on the new, intentionally empty database, run the complete rebuild
yourself. The exact database name is required as a safety confirmation:

```bash
cd /home/ec2-user/woa
NODE_ENV=production npm run db:rebuild -- --confirm <DB_NAME>
```

No bootstrap or deployment command in this guide runs that operation
automatically.

## 5. Configure and start PM2

Start the application and worker without running migrations:

```bash
cd /home/ec2-user/woa
./deploy.sh code-only
```

Register the current PM2 installation with systemd and save the process list:

```bash
sudo env PATH="$PATH:/usr/local/bin" pm2 startup systemd \
  -u ec2-user --hp /home/ec2-user
pm2 save
sudo systemctl status pm2-ec2-user --no-pager
```

Verify both processes:

```bash
pm2 status
pm2 logs --lines 100
```

## 6. Benchmark before cutover

Keep the existing Elastic IP on the old instance. Use the temporary address of
the ARM instance and reproduce the benchmark with identical settings:

- same Git commit and `.env.production` performance settings;
- same segment archive;
- same 3,058-workout archive;
- first upload into an empty database;
- at least two overwrite uploads;
- identical EBS type, IOPS, and throughput.

Record `free -h`, `vmstat 1`, CPU credit metrics, and the complete upload profile.

## 7. Production cutover

Before moving the Elastic IP:

1. Copy and validate the production Nginx configuration.
2. Make the TLS certificate and private key available on the new instance.
3. Stop application and worker on the old instance.
4. Associate the existing Elastic IP with the new instance.
5. Verify HTTPS, login, upload, worker processing, and SSH access.

Keep the old instance stopped but intact until the new environment has been
verified. Moving the Elastic IP back provides the quickest rollback.
