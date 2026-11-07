# Production Deployment Guide

This guide covers deploying FreeFrame to a production server using Docker Compose.

---

## Install on a fresh server

This is the easiest way to run FreeFrame, and the one we recommend if you have not run a server before. You rent a small Linux server, paste one command, and answer four or five short questions (the fifth only on a server with an NVIDIA GPU that Docker cannot use yet). The installer does the rest: it sets up Docker (the program FreeFrame runs inside), starts FreeFrame, gets a free HTTPS certificate, creates your admin account and turns on nightly backups. It takes a few minutes.

The manual ways further down this guide ([run the published images](#run-the-published-images) and [build from source](#build-from-source)) stay fully supported. Use them if you already run servers your own way, or if your server cannot use the installer.

### 1. Rent a server

You need a server that nothing else important runs on, with:

- **Operating system:** Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13. The processor can be amd64 (also called x86_64) or arm64. Pick "Ubuntu 24.04" when the provider asks which system to install.
- **Size:** the [hardware table](#hardware-requirements) below has the details. For a small team, 2 CPU cores, 4 GB of memory and 20 GB of disk is the minimum, and 4 cores, 8 GB and 50 GB is a good start. The installer refuses a server with less than about 2 GB of memory, and warns below 4 GB. If you keep footage on the server itself, more disk helps: roughly 20 GB per hour of 1080p footage, counting the original and the copies FreeFrame makes for reviewing.
- **Ports 80 and 443 reachable from the internet.** Port 80 is plain web traffic and port 443 is secure (HTTPS) web traffic. Most providers call this the "firewall" or "security group" of the server; open both. FreeFrame needs port 80 even when it serves HTTPS, because that is how the certificate is issued.
- **A way to log in as an administrator,** usually SSH with a user that can run `sudo` (or the root user). Your provider shows you how.

Any provider works: Hetzner, DigitalOcean, AWS, Google Cloud, Azure, Hostinger, or a server in your own office. See [Deployment Options](#deployment-options) for sizes and prices.

### 2. Run the command

Log in to the server and run:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh)"
```

The installer is for **Linux servers only**:

- **Supported:** Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13, on amd64 or arm64.
- **Not macOS or Windows.** On a Mac, use the manual compose setup ([run the published images](#run-the-published-images)) with Docker Desktop. On Windows, Ubuntu in WSL2 with systemd switched on works for trying FreeFrame, but it is not something a team should rely on: its address changes when Windows restarts, and it stops when the PC sleeps.
- **Other Linux distributions:** use the manual compose setup ([run the published images](#run-the-published-images)).

This downloads a small script and runs it as the administrator (`sudo`). The script runs `freeframe install`, which checks the server first and changes nothing if a check fails. You can read the script before running it: it is [`install.sh`](../install.sh) in this repository.

The command works from v1.22.0, the first release that has the installer. `latest` is the newest published release. We will switch this command to `stable`, the release we have validated for production, once the first release containing the installer has been promoted there.

If you need to set a variable (see [Unattended installs](#unattended-installs-cloud-init-ansible) below), put it after `sudo`, because `sudo` drops variables set before it:

```bash
sudo FREEFRAME_DOMAIN=review.yourstudio.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh)"
```

To give answers as options instead, write `install` after the closing quote, then the options. With `bash -c`, the first word after the script is only its name, so `install` must be there:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh)" install --domain review.yourstudio.com
```

**Why `bash -c` and not `curl ... | sudo bash`?** Ubuntu 26.04's `sudo` is sudo-rs, which cannot pass your keyboard to a script that arrives through a pipe: the first question would freeze. The installer notices this before it downloads anything, and shows the `bash -c` command to use instead. The `bash -c` form works with every `sudo`. A piped command is still fine for [unattended installs](#unattended-installs-cloud-init-ansible), which ask nothing.

What the installer does, in order:

1. Checks the system, the memory and disk, that nothing else is using ports 80 and 443, and that the server can reach the internet.
2. Asks you the questions below, and shows a summary to confirm.
3. Installs Docker from Docker's own repository if the server has none. If you chose to use the server's NVIDIA GPU, it sets up NVIDIA's container toolkit (see [Video processing on a GPU](#video-processing-on-a-gpu)). If the server has less than 4 GB of memory and no swap (spare memory on disk), it adds a 2 GB swap file. If the `ufw` firewall is on, it allows web traffic and SSH.
4. Waits for your domain's DNS to point at the server, if you gave a domain.
5. Downloads FreeFrame (about 2 GB, a few minutes), starts it, and creates your admin account before opening it to the outside.
6. Waits for the HTTPS certificate and turns on the nightly backup.

Everything it does is also written to `/opt/freeframe/install.log`. FreeFrame lives in `/opt/freeframe` from now on.

### 3. The questions

The questions come as numbered steps (`Step 1 of 4`, and so on). Where there are choices, the installer shows a numbered menu with only the choices that fit your server, and the suggested one in brackets: press Enter to take it.

**1. Web address.** The address your team types in the browser. You have three choices:

- **Your own domain**, for example `review.yourstudio.com`. This is the right choice for real use. Choose it, then type the domain (you can also type the domain straight at the menu). You will need to point the domain at the server first; see [The DNS step](#the-dns-step) below.
- **The free automatic address**, offered when the server has a public IP address: press Enter, and FreeFrame uses an address of the form `<your-server-ip>.sslip.io` (for example `203.0.113.10.sslip.io`) with a real HTTPS certificate. sslip.io is a free public service that turns any IP address into a name. It is temporary: it is fine for trying FreeFrame, but it belongs to the IP address, so use your own domain for production. You can switch later with `sudo freeframe configure`.
- **This network only.** For a server inside an office that people reach only from the office network. FreeFrame then uses plain HTTP on the server's own address, with no certificate. See [A server in your office](#a-server-in-your-office-behind-a-router-nat) below. On a server without a public IP address this is the suggested choice. On a public server the menu calls it "Plain HTTP on this server's address".

**Email for certificate notices** (part of the web address step). Only asked when you use HTTPS. Let's Encrypt, the free service that issues the HTTPS certificate, writes to this address if something needs attention, such as a certificate that cannot be renewed. Use an address that someone reads.

**2. Where footage is kept.**

- **On this server** (the simplest). Uploaded files live on the server's disk. The installer tells you roughly how many hours of 1080p footage fit.
- **In an S3 bucket you already have** (AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces). "S3" is the standard way storage services share files. The installer asks for the bucket's address (endpoint; press Enter for AWS S3), bucket name, access key, secret key and region (for Cloudflare R2 type `auto`), all of which your storage provider shows you. For AWS S3 the installer prints, at the end, the CORS rules to paste into the bucket so that browsers may upload to it (AWS does not set them for you).

**3. Email (SMTP).** FreeFrame sends sign-in codes and invitations by email. Choose to set up a mail server, then type your mail provider's server address (for example `smtp.postmarkapp.com`), its port (usually 587), user name, password and the address emails are sent from. Or press Enter to skip it and add email later with `sudo freeframe configure`.

> **Without email, sign-in codes and invitation emails are not sent, and there is no password reset.** Invitation links can still be copied from the admin page and sent by hand. You sign in as the admin with the password you choose, so you are not locked out. Setting up email is worth doing before you invite a team.

**4. Your admin account.** Your name, your email address, and a password of 8 to 72 characters. If you press Enter instead of choosing a password, the installer makes a strong one for you, **shows it once on the screen at the end, and saves it nowhere**. Write it down before you close the window.

**5. Video processing** (only on a server with an NVIDIA GPU that Docker cannot use yet). See [Video processing on a GPU](#video-processing-on-a-gpu) below. Press Enter to use the GPU.

Then the installer shows what it is about to do, including whether video is processed on the GPU or the CPU, and asks `Install now? [Y/n]`.

### Video processing on a GPU

FreeFrame prepares every uploaded video for review in the browser (it transcodes it). The server check at the start says what it found, on a line such as `GPU: NVIDIA GeForce RTX 5070 Ti (driver 610.47)`, `GPU: Intel (not used with the published images)` or `GPU: none found`, and the summary, the closing message and `sudo freeframe status` say whether video is processed on the GPU or the CPU.

- **An NVIDIA GPU whose driver works** (`nvidia-smi` answers). Docker also needs NVIDIA's container toolkit to give the GPU to a container. If it is already set up, the installer uses the GPU without asking. If not, it asks `Use the NVIDIA GPU for video processing? [Y/n]`. On yes, after you confirm the install, it installs `nvidia-container-toolkit` from NVIDIA's own apt repository, sets Docker up for it (`nvidia-ctk runtime configure --runtime=docker`) and restarts Docker. FreeFrame then runs with `docker-compose.gpu.yml`, which gives the transcoding worker the GPU; when a GPU attempt fails, the worker falls back to the CPU on its own. Once FreeFrame has started, the installer asks the worker whether it sees the GPU (`nvidia-smi -L` inside it); if it does not, it starts the worker again once and asks again, and if it still does not, the install finishes and the closing message says `Video processing: CPU for now` with what to do. `update`, `rollback`, `restore`, `restart` and `configure` do the same check after they start FreeFrame with the GPU. If the toolkit cannot be set up, the installer says so, keeps the CPU and finishes the install.
- **An NVIDIA GPU without a working driver.** The installer never installs or changes drivers. It says so, suggests how to install one (on Ubuntu `sudo ubuntu-drivers install`, then a reboot; on WSL2 the NVIDIA driver for Windows), and installs FreeFrame on the CPU. Once the driver works, turn the GPU on with `sudo freeframe configure`.
- **An Intel or AMD GPU.** The published images use NVIDIA GPUs only, so FreeFrame processes video on the CPU. Intel (VAAPI) needs images you build yourself; see [Hardware-Accelerated Transcoding](#hardware-accelerated-transcoding-optional).
- **No GPU.** Video is processed on the CPU, with no question.

The choice is saved as `FREEFRAME_GPU=nvidia` or `off` in `/opt/freeframe/.env.prod`, and running the installer again keeps it. To change it later, run `sudo freeframe configure` (or `sudo freeframe configure --yes --gpu nvidia`, or `--gpu off`). Turning the GPU on there may set the toolkit up, which restarts Docker: every container on the server stops for a moment, and FreeFrame is started again after. Unattended installs use the GPU only when Docker can already use it, or when you add `--gpu nvidia` (`FREEFRAME_GPU=nvidia`), which also sets the toolkit up.

WSL2 works: there the driver is the Windows one, and `nvidia-smi` lives in `/usr/lib/wsl/lib`.

### The DNS step

If you chose your own domain, FreeFrame needs the domain to lead to your server before it can get a certificate.

**DNS** is the internet's address book. It says which server a name like `review.yourstudio.com` belongs to. An **A record** is one entry in it: a name, and the IP address of the server.

You manage DNS at the company where you bought the domain, or at whoever you pointed it to (a "nameserver" provider such as Cloudflare). Look for a menu called **DNS**, **DNS records**, **DNS management** or **Advanced DNS**:

- **GoDaddy:** My Products, next to your domain choose DNS.
- **Namecheap:** Domain List, Manage next to your domain, then the Advanced DNS tab.
- **Cloudflare:** pick the domain, then DNS, then Records.
- **Google Domains, Squarespace Domains and most others:** open the domain, then look for DNS or DNS settings.
- **Hetzner, DigitalOcean, AWS Route 53 and other cloud providers:** their DNS or Networking section, under the domain.

Add an A record with the name of your address and the server's IP address as the value. The installer prints exactly what to add, for example:

```
Add an A record with the name review and the value 203.0.113.10 (for review.yourstudio.com)
Add an A record with the name storage.review and the value 203.0.113.10 (for storage.review.yourstudio.com)
```

The second line appears when footage is kept on the server: uploads go to a second name, `storage.` followed by your address. If a name already has an AAAA record (the IPv6 version of an A record), remove it unless it points at this server. If you use Cloudflare, set the records to "DNS only" (grey cloud, not the orange proxied cloud): the installer checks that the name leads to the server itself, and the certificate is issued to the server.

New records usually work within a few minutes, and sometimes take up to an hour. The installer **waits until DNS points at the server**, checking every 15 seconds, so a typing mistake never uses up Let's Encrypt's limited attempts. With a terminal you can press Enter to check now, type `c` and Enter to continue anyway (the certificate then waits until the records work), or type `s` and Enter to use the free automatic address instead. Without a terminal it waits up to 30 minutes, then stops and tells you to run it again once the records work.

### A server in your office (behind a router, NAT)

A server in an office or at home usually sits behind a router. It has a private address on the office network (like `192.168.1.50`) and shares one public address with everything else. This is called NAT. The installer notices it, and the web address menu says so under **This network only, plain HTTP**.

- **To use FreeFrame inside the office only,** choose **This network only** (or type `local`). FreeFrame then answers on plain HTTP at the server's own address, for example `http://192.168.1.50`. Browsers mark it "Not secure"; that is normal on a private network. If footage is kept on the server, uploads also use port 9000 on the server.
- **To reach FreeFrame from outside the office,** the router must **forward ports 80 and 443 to the server** (a "port forward" or "virtual server" rule in the router's settings), and you should use a domain pointing at the office's public address. The automatic `sslip.io` address also needs the same forwarding. If ports 80 and 443 are not forwarded, the certificate cannot be issued, and the installer falls back to plain HTTP on the server's local address after a few minutes. It says so when it does.

Cloud servers (AWS, Google Cloud, Azure) behave like normal public servers: open ports 80 and 443 in the provider's firewall or security group and everything works as described above. Because these servers have a private address inside the provider's network, the installer may show the same "behind a router" hint; ignore it and press Enter or type your domain.

### When it finishes

The installer ends with a summary: your web address, your admin email, where the settings, backups and log are, and the commands you will need. Open the address in a browser and **sign in** with the admin email and password.

Then:

1. **Invite people.** Open the admin area, add their email addresses and choose their role. Without [email set up](#3-the-questions), copy each invitation link from the admin page and send it yourself.
2. **Create a project** and upload a first clip to see it work.
3. **Copy the backups somewhere else** from time to time; see [Backups](#backups-with-the-installer) below.

### Looking after FreeFrame

After the install, the `freeframe` command is on the server. All commands need `sudo`. `sudo freeframe help` lists them.

| Command | What it does |
|---|---|
| `sudo freeframe status` | Shows the version, whether everything is running, where video is processed (GPU or CPU; with the GPU on, it asks the worker whether it sees the GPU), disk space, backups, and whether a newer release is out. |
| `sudo freeframe update` | Backs up the database, then moves to the newest release on your channel (it updates the `freeframe` command first). |
| `sudo freeframe rollback` | After an update that did not come up: goes back to the version from before, with the database as it was just before the update. |
| `sudo freeframe configure` | Changes the answers you gave: web address, email, storage, and whether video is processed on the GPU. With `--yes`, give only the new answers as options. |
| `sudo freeframe backup` | Saves a copy of the database to `/opt/freeframe/backups` now (this also runs every night at 3:00; the newest 7 are kept). |
| `sudo freeframe restore` | Lists the backups. `sudo freeframe restore FILE` puts one back (replaces the current database, after saving a copy of it). |
| `sudo freeframe logs` | Shows FreeFrame's recent messages and follows new ones (Ctrl-C stops). `sudo freeframe logs api` shows one part only. |
| `sudo freeframe restart` | Restarts every part of FreeFrame and waits until it answers. |
| `sudo freeframe uninstall` | Removes FreeFrame from the server, after a final backup, and keeps its data unless you add `--delete-data`. `--dry-run` shows what it would do. See [Removing FreeFrame](#removing-freeframe). |

**Updating.** Run `sudo freeframe update`. It saves a backup of the database first, then downloads and starts the new version, and prints the version before and after. If the new version does not come up, it says so and tells you to run `sudo freeframe rollback`. The rollback puts back the previous version and the database as it was just before the update, so anything people did in FreeFrame after the update began is lost. It keeps the server on the old version until you remove the `FREEFRAME_VERSION` line from `/opt/freeframe/.env.prod`.

**Changing settings later.** To add email, move to your own domain or change storage keys, run `sudo freeframe configure`. It saves a copy of the settings file first and changes only what you changed. It does not move uploaded media between storage places.

### Backups with the installer

- **Nightly at 03:00** (server time), the installer's timer saves a copy of the database and of the settings file to `/opt/freeframe/backups`. The newest 7 are kept. `sudo freeframe backup` makes one right now. A rollback also saves the database it replaces, named `freeframe-<date>-<time>-before-rollback.dump`; it holds the newer release's database, so it is never offered as the newest backup.
- **They are on the same server.** If the server is lost, so are they. Copy the newest backup (`sudo freeframe status` names it) and `/opt/freeframe/.env.prod` to another computer or storage now and then. The files are readable by the administrator only, so copy them as that user, for example with `sudo cat` or by logging in as root.
- **Uploaded media is not in these backups** when footage is kept on the server (it can be very large). If you use your own S3 bucket, the media stays in the bucket; see [S3 Media Backup](#s3-media-backup) for keeping a second copy.
- **To put a backup back:** `sudo freeframe restore` lists them; `sudo freeframe restore FILE` restores one. It asks first, saves a copy of the current database, and then replaces it.

### Moving to a new server

1. On the old server run `sudo freeframe backup`, then copy the backup it just saved (it prints the file name) from `/opt/freeframe/backups` and the file `/opt/freeframe/.env.prod` to your computer.
2. Rent the new server as above. Point your domain's DNS at the new server's address.
3. On the new server, create the folder and put the old settings file in it:
   ```bash
   sudo mkdir -p /opt/freeframe
   sudo install -m 600 .env.prod /opt/freeframe/.env.prod
   ```
   The `-m 600` makes the file readable by the administrator only, because it holds your passwords. (The installer tightens it to that itself, but it is better never to leave it open.)
4. Run the install command. It keeps every setting from the file (including the secrets, which the restored database needs) and skips the questions the file already answers. It still asks for an admin account (with `--yes`, give `FREEFRAME_ADMIN_EMAIL`), because the new server's database starts empty; the restore in the next step replaces that account with your old ones.
5. Run `sudo freeframe restore /path/to/the-copied-file.dump` and answer yes.
6. Give the new server its own web address. The settings file carries the old server's address, and the installer does not check or change an address that comes from a copied file, so the new server would keep the old address, which does not lead to it. If you moved with the same domain, point its DNS at the new server (step 2) and nothing more is needed. Otherwise:
   - If the old server used the free automatic (`sslip.io`) address, run `sudo freeframe configure --https sslip --yes`. It works out the new server's own automatic address from its public IP address.
   - Otherwise, run `sudo freeframe configure` and type the new web address: your domain, or the new server's IP address for "this network only".
7. If footage was kept on the old server, copy the media to the new one as well; the restore brings back the database only. Using your own S3 bucket avoids this: the new server simply uses the same bucket.

### Removing FreeFrame

`sudo freeframe uninstall` removes what the installer set up. Run `sudo freeframe uninstall --dry-run` first: it prints exactly what would be removed and kept, and changes nothing.

It says what it will do and asks you to type the web address (or the word `remove`). Then, in this order, it:

1. **Saves a final backup** of the database (starting the database on its own if FreeFrame is stopped) and moves it, every backup in `/opt/freeframe/backups`, `install.log` and a copy of `.env.prod` to `/root/freeframe-removed-<date>-<time>/`, readable by root only. If the backup fails, nothing is removed. `--skip-backup` makes no final backup; in a terminal you confirm that by typing `no backup`.
2. **Removes** FreeFrame's containers and network, the nightly backup timer, `/opt/freeframe` and, last, the `freeframe` command.
3. **Keeps your data** in its Docker volumes: `freeframe_pgdata` (the database), `freeframe_miniodata` (footage kept on the server), `freeframe_letsencrypt` (the certificates) and `freeframe_redisdata` (the job queue). It prints their names and the command that deletes them later. Footage in your own S3 bucket is never touched.

Docker and its images, NVIDIA's container toolkit, the apt sources, the swap file and the firewall rules are left alone; it prints how to remove each if you want to.

**Putting FreeFrame back.** With the volumes kept, put the saved settings back and run the install command. It uses the settings and the volumes, so the database, footage and certificates come back. The database already has its admin account, so none is made: sign in as before. With `--yes`, no admin answers are needed: once FreeFrame runs, the installer asks the database (`/setup/status`), and only if it has no admin account (an empty database), or the answer is unclear, does it stop, still closed to the outside, and ask you to run it again with `FREEFRAME_ADMIN_EMAIL` set. In a terminal it still asks the admin questions, says the answers are not used when the database already has an admin, and makes none.

```bash
sudo mkdir -p /opt/freeframe
sudo install -m 600 /root/freeframe-removed-<date>-<time>/.env.prod /opt/freeframe/.env.prod
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh)"
```

Without the settings file the installer refuses the kept volumes (they look like a FreeFrame set up by hand) and points at the saved settings. If the volumes are gone, the same steps give an empty FreeFrame; then `sudo freeframe restore /root/freeframe-removed-<date>-<time>/freeframe-<date>-<time>.dump` puts the final backup back. A backup holds the database only, not footage kept on the server.

**Deleting the data too.** `--delete-data` also deletes the volumes, for good. It asks you to type `delete`, even with `--yes`. For an unattended run, give all three: `sudo freeframe uninstall --yes --delete-data --confirm-delete-data` (`--confirm-delete-data` is refused without `--yes`, so in a terminal `delete` is always typed). Without `--yes`, `uninstall` needs a terminal to ask in; with `--yes` it asks nothing, apart from the `delete` question.

If an update or a restore did not finish, `uninstall` still runs, and says first what is lost: an unfinished update's way back (`sudo freeframe rollback`), or, after an unfinished restore, that the database may be empty (the copy from before that restore is kept with the other backups). It refuses a server that runs FreeFrame set up by hand. While another `freeframe` command is running it does not start, and says so: run it again once that one has finished.

**If it stops part-way** (a volume that cannot be deleted, a full disk), run the same command again. It finds the folder the first run saved in and keeps using it. While the database's volume (`freeframe_pgdata`) is still there it makes a final backup again, as a first run does. Once the first run has deleted that volume it makes none, because starting the database then would only make an empty one, and it says so. If the volume is still there but the setup files that start the database are gone, no backup can be made, so it stops without removing anything more and says why; `--skip-backup` on that run goes on without one. The summary names the newest backup really made as the one to restore. Starting FreeFrame again instead (`restart`, `update`, `configure`, `rollback`, `restore` or the installer) cancels the unfinished uninstall.

### Unattended installs (cloud-init, Ansible)

For a script with nobody at the keyboard, give every answer ahead of time. This is the one case for a piped command (`curl ... | bash`): a run that asks nothing works with every `sudo`, sudo-rs included. With someone at the keyboard, use the `bash -c` command from [Run the command](#2-run-the-command). Each question has an environment variable and a matching option (`--domain`, `--admin-email` and so on; an option wins over its variable). Add `FREEFRAME_YES=1` (or `--yes`) so the installer does not wait for a terminal.

| Variable | Meaning |
|---|---|
| `FREEFRAME_DOMAIN` | Your domain, for example `review.yourstudio.com`. |
| `FREEFRAME_HTTPS` | `auto` (the default), `own`, `sslip` or `off`. `auto` uses your domain when you give one, otherwise the automatic address on a public server, otherwise plain HTTP. |
| `FREEFRAME_ACME_EMAIL` | Email for certificate notices (the admin email when left out). |
| `FREEFRAME_STORAGE` | `bundled` (on this server, the default) or `s3`. |
| `FREEFRAME_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY`, `_REGION` | Your bucket, when storage is `s3`. |
| `FREEFRAME_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_FROM` | Your mail server. Leave them all out for no email. |
| `FREEFRAME_ADMIN_NAME`, `_EMAIL`, `_PASSWORD` | The admin account. The email is required, except when you put FreeFrame back over its kept data (the settings file and the `freeframe_pgdata` volume are both there): then the existing admin is used, and the email is asked for only if the database has none. |
| `FREEFRAME_CHANNEL` | `latest` or `stable` (or a release tag that includes the installer). |
| `FREEFRAME_GPU` | `nvidia` to process video on the server's NVIDIA GPU, setting up NVIDIA's container toolkit when Docker cannot use the GPU yet (the driver must already work), or `off` for the CPU. Left out, the GPU is used only when Docker can already use it. See [Video processing on a GPU](#video-processing-on-a-gpu). |
| `FREEFRAME_YES` | `1` to run without asking anything. |

Example, as cloud-init runs it (as root, so no `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh | \
  FREEFRAME_YES=1 \
  FREEFRAME_DOMAIN=review.yourstudio.com \
  FREEFRAME_ADMIN_EMAIL=you@yourstudio.com \
  FREEFRAME_ADMIN_PASSWORD='a-long-password-you-chose' \
  bash
```

Two rules for unattended installs:

- **Set `FREEFRAME_ADMIN_PASSWORD` yourself.** If you leave it out, the installer makes a password and prints it, and in an unattended run that output lands in the cloud-init log, where other people may read it.
- **Pass secrets as variables, not as options.** Anything on a command line (`--admin-password`, `--smtp-password`, `--s3-secret-key`) can be seen by other users of the server with `ps`; variables cannot.

If a required answer is missing, the installer stops before changing anything and names the variable to set. With a domain, an unattended run waits up to 30 minutes for the DNS records (see [The DNS step](#the-dns-step)); add the records first, or leave the domain out and use `FREEFRAME_HTTPS=sslip`.

### If you already run FreeFrame

**The installer refuses a server that already runs FreeFrame set up by hand** (a clone, or the published-images compose files), and leaves it completely alone: it changes nothing and tells you so. Keep updating that server with the manual steps in the rest of this guide; they are fully supported and unchanged. The installer is for new servers.

### Troubleshooting the installer

Everything the installer does is written to **`/opt/freeframe/install.log`**. Every stop message also says what was already done and what to try. It is safe to run the install command again: it keeps your settings and continues from where it stopped.

| What you see | What it means |
|---|---|
| "This server runs ... which is not supported yet", or "The FreeFrame installer is for Linux servers" | The system is not Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13 (a Mac or Windows included), or the processor is not amd64 or arm64. Nothing was changed. Use a supported server, or follow the manual steps below. |
| "This server's sudo (sudo-rs ...) cannot pass the keyboard to a script that arrives through a pipe" | You ran `curl ... \| sudo bash` on Ubuntu 26.04. Nothing was changed. Run the `sudo bash -c "$(curl ...)"` command the message shows. |
| "This server has ... MB of memory. FreeFrame needs at least 2 GB" | The server is too small. Choose one with 4 GB or more. |
| "This server already runs FreeFrame that was set up by hand" | See [If you already run FreeFrame](#if-you-already-run-freeframe) above. |
| "Port 80 (or 443) is used by ..." | Another program, often Apache or nginx, uses the web ports. With a terminal, the installer offers to stop it; otherwise stop it yourself and run the command again. |
| "This server cannot reach ghcr.io" | The server has no internet, or the provider's firewall blocks outgoing HTTPS (port 443). FreeFrame is downloaded from ghcr.io. |
| "Docker on this server was installed with snap" or "needs Docker 24 or newer" | The Docker already on the server cannot be used. The message says how to remove or update it. |
| "There is no terminal here to answer the installer's questions" | The command ran without a terminal (a script). Add `--yes` and give the answers ahead of time; see [Unattended installs](#unattended-installs-cloud-init-ansible). |
| "The DNS records for ... do not point at this server" | The A record is missing or has not spread yet. Add the records the installer printed, wait, and run the command again. |
| Browser warns about the certificate | The certificate has not arrived yet. Check the DNS records and that ports 80 and 443 are open, then run `sudo freeframe restart`. `sudo freeframe status` shows the certificate. |
| "Could not download the freeframe command" | The server cannot reach `raw.githubusercontent.com`, or the channel has no installer yet. |
| "GPU: NVIDIA (no working driver)" | The server has an NVIDIA card but `nvidia-smi` does not answer. Install the driver (on Ubuntu `sudo ubuntu-drivers install`), reboot, then run `sudo freeframe configure`. FreeFrame works on the CPU meanwhile. |
| "The NVIDIA container toolkit could not be set up" | The install finished on the CPU. The reason is at the end of `install.log`, often that the server cannot reach `nvidia.github.io`. Try again with `sudo freeframe configure`. |
| `status` says the worker does not see the GPU | The line names the reason and the command that fixes it. |
| "Video processing: CPU for now: the worker could not use the GPU" | After FreeFrame started, the worker (which processes video) did not see the GPU, and still did not after it was started again; its `nvidia-smi` says `Failed to initialize NVML` (on WSL2: `GPU access blocked by the operating system`). Video is processed on the CPU meanwhile, and `FREEFRAME_GPU=nvidia` is kept. Run `sudo freeframe restart`. If `sudo freeframe status` still says the CPU, check that `nvidia-smi` works on the server; on WSL2, run `wsl --shutdown` in Windows, start WSL again, then run `sudo freeframe restart`. What the worker's `nvidia-smi` said is in `install.log` (lines starting `GPU self-check:`). |
| `status` says the GPU is chosen but the worker does not see it, some time after FreeFrame started | Any later `systemctl daemon-reload` on the server (an `apt upgrade` that touches systemd units, for example) takes the GPU from the running worker until `sudo freeframe restart`. This happens when Docker uses the systemd cgroup driver, as [NVIDIA documents](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/troubleshooting.html#containers-losing-access-to-gpus-with-error-failed-to-initialize-nvml-unknown-error). FreeFrame's own commands avoid that reload or check the worker after it; the server-wide fixes are Docker's `native.cgroupdriver=cgroupfs` setting or NVIDIA's documented workaround, and the installer does not change either. |
| "Video processing: stopped: the worker that processes video is not running" | The worker did not start at all, so no video is processed. See why with `sudo freeframe logs worker`. |
| The command printed nothing, or only a `curl:` error | If the command printed nothing, check that this server can reach raw.githubusercontent.com (curl printed the reason). With `bash -c "$(curl ...)"`, a failed download leaves nothing to run, so the installer cannot say so itself. |

Still stuck? Open an issue at <https://github.com/Techiebutler/freeframe/issues> and attach the end of `/opt/freeframe/install.log`. The log is private to the administrator, and it does not hold the admin password the installer makes for you.

---

## Hardware Requirements

| | Minimum | Recommended | Heavy Workload |
|---|---|---|---|
| **CPU** | 2 cores | 4 cores | 8+ cores |
| **RAM** | 4 GB | 8 GB | 16+ GB |
| **Storage** | 20 GB SSD | 50 GB SSD | 100+ GB NVMe |
| **Bandwidth** | 100 Mbps | 500 Mbps | 1 Gbps |

- **Minimum** — Small teams (up to 10 users), light video transcoding
- **Recommended** — Medium teams (10-50 users), regular video uploads
- **Heavy Workload** — Large teams (50+ users), frequent 4K video processing

> **Note:** Video transcoding is the most resource-intensive operation. Storage needs depend on your media volume and where it is kept: with your own S3 bucket the media files are stored there, not on the server; with storage on the server (the installer's default, or `docker-compose.storage.yml`) they need disk on it.

---

## Deployment Options

FreeFrame runs anywhere Docker is available. Here are common hosting options:

### VPS / Cloud VM (Simplest)

Best for most teams. A single server running Docker Compose.

| Provider | Recommended Plan | Est. Cost/mo |
|----------|-----------------|--------------|
| **Hetzner** | CPX31 (4 vCPU, 8 GB) | ~$15 |
| **DigitalOcean** | Droplet (4 vCPU, 8 GB) | ~$48 |
| **AWS EC2** | t3.medium (4 vCPU, 8 GB) | ~$60 |
| **Google Cloud** | e2-custom (4 vCPU, 8 GB) | ~$75 |
| **Azure** | B4s (4 vCPU, 8 GB) | ~$70 |
| **Hostinger VPS** | KVM 4 (4 vCPU, 16 GB) | ~$16 |

**Setup:** SSH into your server and run the [installer](#install-on-a-fresh-server). To set it up by hand instead, install Docker and follow the [Quick Setup](#quick-setup) below.

### Cloud with Managed Services

For teams that want managed databases and less maintenance. Use external PostgreSQL, Redis, and S3 instead of the Docker-included ones. See [Bring Your Own Infrastructure](#bring-your-own-infrastructure).

| Component | AWS | GCP | Azure |
|-----------|-----|-----|-------|
| Server | EC2 / ECS | Compute Engine / Cloud Run | VM / Container Apps |
| Database | RDS PostgreSQL | Cloud SQL | Azure Database for PostgreSQL |
| Redis | ElastiCache | Memorystore | Azure Cache for Redis |
| Storage | S3 | Cloud Storage | Blob Storage (via S3 API) |
| Email | SES | (use SMTP) | (use SMTP) |

### Bare Metal / On-Premise

FreeFrame is fully self-contained. On Ubuntu or Debian, run the [installer](#install-on-a-fresh-server), which installs Docker too; on any other Linux server, install Docker and follow the Quick Setup. Ideal for organizations that require media to stay on their own hardware.

---

## Prerequisites

For the manual setup below (the [installer](#install-on-a-fresh-server) sets up Docker and storage itself):

- A server meeting the [hardware requirements](#hardware-requirements) with **Docker** and **Docker Compose** installed
- A **domain name** pointed to your server's IP (for SSL — optional for testing)
- An **S3-compatible storage** bucket (AWS S3, Cloudflare R2, Backblaze B2, etc.), or storage on the server with `docker-compose.storage.yml`
- An **SMTP server** or AWS SES for sending emails

## Quick Setup

These are the manual ways, fully supported next to the [installer](#install-on-a-fresh-server). There are two: **run the published images** (no clone, no build) or **build from source**. Both use the same `.env.prod` and the same data. If you already run FreeFrame from a clone, nothing changes for you: build from source stays fully supported.

### Run the published images

This works from v1.22.0, the first release that has these compose files. You need only the compose files and your settings; download them from the ref you want to follow (`latest`, or a pinned `vX.Y.Z` from v1.22.0 on). `latest` is the newest published release. We will switch these commands to `stable`, the release we have validated for production, once the first release containing these files has been promoted there.

```bash
mkdir freeframe && cd freeframe
# Download the files, then create your production environment file and edit it with your
# actual credentials. Nothing after the download runs unless every file arrived.
# At minimum: change passwords, set FRONTEND_URL to your https:// URL, configure S3, email, and JWT_SECRET
( set -e; for f in docker-compose.prod.yml docker-compose.images.yml .env.example; do
    curl -fsSLO "https://raw.githubusercontent.com/Techiebutler/freeframe/latest/$f" \
      || { echo "Could not download $f: check the ref." >&2; exit 1; }
  done ) \
  && cp .env.example .env.prod \
  && nano .env.prod

# Start all services (pulls the images, builds nothing)
docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.images.yml up -d

# Check that everything is running
docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.images.yml ps
```

`docker-compose.images.yml` only adds the image names to `docker-compose.prod.yml`. Its default version is the release the file belongs to, so the compose files and the images always match. Set `FREEFRAME_VERSION` in `.env.prod` (for example `1.22.0`, no leading `v`) to pin another version. Use the same `-f` flags for every later command, and add `-f docker-compose.https.yml` or `-f docker-compose.storage.yml` as you need them (both are downloaded the same way).

The published web image is built for the domain root. For a sub-path deployment, Intel (VAAPI) transcoding, or your own code changes, build from source. An NVIDIA GPU works with the published images: see [Hardware-Accelerated Transcoding](#hardware-accelerated-transcoding-optional).

### Build from source

```bash
# 1. Clone the repository
git clone https://github.com/Techiebutler/freeframe.git
cd freeframe

# 2. Create your production environment file
cp .env.example .env.prod

# 3. Edit .env.prod with your actual credentials
#    At minimum: change passwords, set FRONTEND_URL to your https:// URL, configure S3, email, and JWT_SECRET
nano .env.prod

# 4. Build and start all services
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

# 5. Check that everything is running
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

FreeFrame is now running on **port 80** (either path). The first user to sign up becomes the super admin via the setup wizard.

---

## SSL / TLS Setup

FreeFrame uses **Traefik** as its reverse proxy. HTTPS with **Let's Encrypt** certificates is opt-in: add `docker-compose.https.yml` to the command. `docker-compose.prod.yml` on its own serves plain HTTP on port 80 and never requests a certificate, even if `DOMAIN` and `ACME_EMAIL` are set.

### Enabling SSL

Set these variables in your `.env.prod`:

```
DOMAIN=your-domain.com
ACME_EMAIL=admin@your-domain.com
FRONTEND_URL=https://your-domain.com
```

Then add `-f docker-compose.https.yml` to the command you already use, and start (or restart) the services. Building from source:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.https.yml up -d --build
```

Running the published images (download `docker-compose.https.yml` next to the other compose files first):

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.images.yml -f docker-compose.https.yml up -d
```

Use the same `-f` flags for every later `docker compose` command (`ps`, `logs`, `down`). Traefik will:
- Request an SSL certificate from Let's Encrypt for `DOMAIN`
- Serve your site over HTTPS on port 443
- Redirect plain HTTP on port 80 to HTTPS
- Auto-renew the certificate before it expires

`docker compose` refuses to start if `DOMAIN` or `ACME_EMAIL` is empty when the HTTPS file is used.

With the HTTPS file, every plain-HTTP request is redirected to HTTPS, so opening the server by its IP address or another hostname lands on HTTPS with a certificate warning. Use the domain.

> **Requirements:** Your domain's DNS A record must point to your server, and ports 80 + 443 must be open. Traefik needs port 80 for the ACME HTTP challenge even when serving HTTPS.

### Without SSL (HTTP only)

Leave out `-f docker-compose.https.yml`, as in the [Quick Setup](#quick-setup) commands. FreeFrame then runs on **HTTP port 80** only, whatever `DOMAIN` and `ACME_EMAIL` are set to. This is fine for:
- Local testing of the production build
- Running behind an external reverse proxy that handles SSL

### Behind an External Reverse Proxy (Cloudflare, Caddy, etc.)

If FreeFrame sits behind another proxy that already handles SSL:

1. Use `docker-compose.prod.yml` alone, without `docker-compose.https.yml`, so Traefik runs in HTTP mode
2. Point your external proxy to FreeFrame's port 80
3. Ensure the proxy forwards these headers: `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`
4. For **Cloudflare**: set SSL mode to "Full"
5. Set `FRONTEND_URL` in `.env.prod` to your `https://` URL

### Sub-path Deployments

To serve FreeFrame under a path instead of the domain root — `https://example.com/freeframe/` — set the base path and rebuild the web image:

```
NEXT_PUBLIC_BASE_PATH=/freeframe
FRONTEND_URL=https://example.com/freeframe
```

`NEXT_PUBLIC_BASE_PATH` is a **build-time** variable for the Docker image (Compose passes it as a build arg), so changing it needs `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web`, not a restart. (`next dev` in the dev stack reads it when the server starts.) Everything the web app serves moves under the prefix: pages, links, static assets, icons and raw navigations. The API stays at the origin root (`/api`), and links built from `FRONTEND_URL` carry the path, so invite and share emails keep pointing inside the mounted app. CORS matches the bare origin, since a browser's `Origin` header never carries a path.

If something sits in front of FreeFrame (a landing page, another app), forward the sub-path to FreeFrame **unchanged** — Next expects the prefix — and forward the API at the origin root as well, because that is where the browser still calls it, including the request bodies it sends. With nginx that is three `proxy_pass` locations, none with a URI part:

```nginx
# Two locations for the sub-path, not one. With trailingSlash unset, Next
# answers /freeframe/ with a 308 to /freeframe, and a lone "location /freeframe/"
# answers /freeframe with nginx's own 301 back, so the two would bounce forever.
# The exact match takes /freeframe itself before that 301 can happen. The
# slash-terminated prefix takes everything under it without also swallowing
# siblings such as /freeframe-docs or /freeframe.html, which a bare
# "location /freeframe" would send to FreeFrame's 404.
location = /freeframe {
    proxy_pass http://127.0.0.1:80;
}

location /freeframe/ {
    proxy_pass http://127.0.0.1:80;
}

location /api/ {
    # Project posters are the only large bodies the browser sends to the API.
    # The API accepts 10 MB; nginx's 1 MB default would reject them with an
    # HTML 413 the frontend cannot parse.
    client_max_body_size 10m;
    proxy_pass http://127.0.0.1:80;
}
```

Traefik in the bundled Compose already routes the sub-path to the web app and `/api` to the API, so forwarding both to FreeFrame's port 80 is enough; only a proxy that terminates the sub-path itself has to name the API separately. Leave `NEXT_PUBLIC_BASE_PATH` empty for a root deployment (the default).

---

## Bring Your Own Infrastructure

FreeFrame's Docker Compose includes PostgreSQL and Redis by default, but you can use external managed services instead.

### External Database (PostgreSQL)

Works with: **AWS RDS, Google Cloud SQL, Supabase, Neon, DigitalOcean Managed DB, or any PostgreSQL 15+ instance.**

1. Remove the `postgres` service and `pgdata` volume from `docker-compose.prod.yml`
2. Remove `postgres` from the `depends_on` of the `api`, `worker`, and `maintenance_worker` services
3. In `.env.prod`, set `DATABASE_URL` to your external database:
   ```
   DATABASE_URL=postgresql://user:password@your-db-host:5432/freeframe
   ```
4. Run migrations once manually on first deploy:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic upgrade head"
   ```

### External Redis / Valkey

Works with: **AWS ElastiCache, Upstash, Redis Cloud, DigitalOcean Managed Redis, or any Redis 7+ / Valkey instance.** Valkey is a drop-in Redis replacement and works out of the box.

1. Remove the `redis` service and `redisdata` volume from `docker-compose.prod.yml`
2. Remove `redis` from the `depends_on` of the `api`, `worker`, `email_worker`, `maintenance_worker`, and `beat` services
3. In `.env.prod`, set `REDIS_URL` to your external instance:
   ```
   REDIS_URL=redis://:password@your-redis-host:6379/0
   ```

### External S3 Storage

Works with: **AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Silo, Garage, MinIO, or any S3-compatible service.**

The production compose runs no S3 service by default, so you provide your own. To keep media on the same host, add `docker-compose.storage.yml`, which runs [Silo](https://github.com/pgsty/silo), a maintained fork of MinIO, and creates the bucket (see [Bundled storage](#bundled-storage-silo) below). (`docker-compose.prod.yml` still ships a commented-out block running the same Silo setup, for installs that already uncommented it; see the notes above it. The `minio/minio` and `minio/mc` images it used before can no longer be pulled from Docker Hub. Silo reads the same `MINIO_*` variables and opens an existing MinIO data volume as is.) Configure in `.env.prod`:

```
S3_STORAGE=s3
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY=YOUR_ACCESS_KEY
S3_SECRET_KEY=YOUR_SECRET_KEY
S3_REGION=us-east-1
```

`S3_BUCKET` must be a valid S3 bucket name: 3-63 characters, lowercase letters, digits, hyphens and dots only. Underscores and capitals are rejected.

For **non-AWS S3-compatible providers** (R2, B2, Spaces, MinIO, Hetzner, …), set `S3_STORAGE` to a non-`s3` value (e.g. `minio`) so `S3_ENDPOINT` is used — with `S3_STORAGE=s3` the client talks to native AWS and the endpoint is **ignored** (FreeFrame refuses to start if `s3` is combined with a non-AWS endpoint). Then set the endpoint:

| Provider | S3_ENDPOINT |
|----------|-------------|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` |
| Silo or MinIO (self-hosted) | `http://your-silo-host:9000` |
| Garage (self-hosted) | `http://your-garage-host:3900` (or your reverse-proxy URL) |

In non-AWS mode FreeFrame always uses **path-style addressing** (`endpoint/bucket/key`) with **SigV4** signatures — the compatibility baseline every S3-compatible provider accepts. No wildcard bucket DNS is needed in front of a self-hosted store.

#### Bundled storage (Silo)

For a new install, keep media on the same host by adding the storage file to every `docker compose` command:

```bash
docker compose --env-file .env.prod \
  -f docker-compose.prod.yml -f docker-compose.storage.yml up -d
```

(add `-f docker-compose.images.yml` and `-f docker-compose.https.yml` too if you use them). Set these in `.env.prod`:

```
S3_STORAGE=minio
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=<strong value>
S3_SECRET_KEY=<strong value>
S3_BUCKET=<lowercase letters, digits and hyphens only>
S3_PUBLIC_ENDPOINT=<the address the browser uses to reach storage>
```

Uploads go straight from the browser to storage, so `S3_PUBLIC_ENDPOINT` must be reachable from the browser. Two choices:

- **Over HTTPS (with `docker-compose.https.yml`):** point a DNS record for `storage.<your-domain>` at this host and set `STORAGE_DOMAIN=storage.<your-domain>`, `STORAGE_ROUTED=true` and `S3_PUBLIC_ENDPOINT=https://storage.<your-domain>`. Traefik then serves storage on that name and requests its certificate.
- **Over HTTP (no HTTPS file):** leave `STORAGE_ROUTED` unset, set `STORAGE_PORT_BIND=0.0.0.0:9000` and `S3_PUBLIC_ENDPOINT=http://<this host>:9000`, and open port 9000 to the people who use FreeFrame.

`STORAGE_PORT_BIND` defaults to `127.0.0.1:9000`, which keeps the S3 port off the network. The Silo console (port 9001) is never published. `FRONTEND_URL` must be the exact origin people browse to, because the app sets the bucket's CORS rules from it. An existing `miniodata` volume opens as is.

If you already uncommented the block in `docker-compose.prod.yml`, keep using it as the instructions above it say; do not pass both.

#### Bucket CORS — required for uploads

Uploads go **directly from the browser to your bucket** via presigned URLs, so the bucket's CORS must allow your FreeFrame origin.

`ExposeHeaders: ["ETag"]` is still recommended and is included below, but it is no longer required on any backend that supports `ListParts`, which is all of the ones above: the server reads an upload's parts from storage when completing it rather than relying on the browser having read each part's `ETag` response header. It is only used as a fallback on a backend that cannot list parts at all, and that case is logged as a warning. If you are debugging an upload that fails partway, `ETag` exposure is no longer the first thing to suspect.

```json
{
  "CORSRules": [{
    "AllowedOrigins": ["https://your-freeframe-domain.example"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["content-type", "content-md5", "x-amz-content-sha256", "x-amz-date", "x-amz-decoded-content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}
```

`DELETE` is intentionally absent — FreeFrame has no presigned-DELETE flow, and the browser never needs it against the bucket. The `AllowedHeaders` list above is exactly what browser uploads and HLS segment fetches send; `["*"]` also works on most backends, but the list is sufficient and is what FreeFrame's automatic startup config now applies.

Keep the header names **lowercase**, as above. Browsers lowercase every name in `Access-Control-Request-Headers`, so on a store that compares these names exactly, a rule listing `Content-Type` rejects the preflight of every upload that signs a content type. Garage compares these names exactly; Silo, RustFS, Ceph RGW, Cloudflare R2 and AWS S3 ignore case; community MinIO does not apply bucket CORS rules at all. Lowercase works on all of them.

If you allow **more than one origin**, give each origin its own rule rather than listing them all in one. Some backends (Garage) answer a multi-origin rule by joining every entry into a single comma-separated `Access-Control-Allow-Origin` header, which browsers reject — every upload and HLS segment fetch then fails CORS. FreeFrame's automatic startup config already emits one rule per origin.

FreeFrame applies this automatically to **non-AWS** buckets at startup when it has permission (and logs a warning if it can't). The rules allow `FRONTEND_URL`, `http://localhost:3000` and every origin in `CORS_ALLOW_ORIGINS`, the same origins the API accepts; `CORS_ALLOW_ORIGINS=*` becomes a single rule allowing any origin. Older MinIO releases answered this call with `NotImplemented` and allowed every origin regardless, so a browser origin missing from that list only starts failing once you move to a store that enforces bucket CORS (Silo, Garage): add it to `CORS_ALLOW_ORIGINS`. Set it yourself for **AWS S3**, or wherever FreeFrame lacks CORS permission. **Hetzner Object Storage** exposes CORS only via API/CLI (not the Console UI), so it's easy to miss — apply the JSON above with `aws s3api put-bucket-cors`.

#### Abort incomplete multipart uploads — recommended

Add a bucket lifecycle rule that **aborts incomplete multipart uploads after a few days**. It is a backstop: it cleans up the rare empty multipart upload left behind when a request to start an upload times out after storage had already created it. It also frees the parts of any upload that is never completed, which S3 bills for until the upload is aborted. On AWS the API's reaper also finds those empty uploads itself, since nothing in the database refers to them; the rule covers the stores where it cannot.

The rule counts days from when the upload **started**, not from when it last moved. FreeFrame keeps offering Resume on an upload for as long as it keeps moving: its own reaper (`STALE_UPLOAD_TIMEOUT_HOURS`, 24 hours by default) ages an upload by its last activity. So the rule can abort an upload that someone is still resuming, and that upload is lost: its next part or its completion fails, and the file has to be sent again from the start. Pick a number of days above the longest upload you expect people to keep resuming, and above `STALE_UPLOAD_TIMEOUT_HOURS`. For scale, 600 GB at 8 Mbit/s takes about a week, and an upload resumed a little each day can run longer. The 7 days below suits most instances; raise it if yours takes very large files over slow links.

On **AWS S3** (and any store that implements the S3 lifecycle API), save this as `lifecycle.json`:

```json
{
  "Rules": [{
    "ID": "abort-incomplete-multipart-uploads",
    "Status": "Enabled",
    "Filter": { "Prefix": "" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  }]
}
```

and apply it:

```bash
aws s3api put-bucket-lifecycle-configuration --bucket YOUR_BUCKET --lifecycle-configuration file://lifecycle.json
```

That call **replaces** the bucket's whole lifecycle configuration, so if the bucket already has rules, read them first with `aws s3api get-bucket-lifecycle-configuration --bucket YOUR_BUCKET` and add this rule to them. For a store that is not AWS, add `--endpoint-url` with its S3 endpoint. The same rule can be created in the AWS console, under the bucket's **Management** tab (lifecycle rules).

**MinIO and Silo** have no equivalent rule to set: `mc ilm rule add` has no option for it, and Silo's `mc ilm import` rejected a rule with `AbortIncompleteMultipartUpload` as not valid for its lifecycle schema. MinIO expires abandoned multipart uploads on its own, after about 24 hours, so there is nothing to configure there. On either, the API's own reaper (`STALE_UPLOAD_TIMEOUT_HOURS`) still reclaims the uploads it has a record of.

### External SMTP

> **⚠️ Email is required for login.** FreeFrame authenticates with emailed **magic codes**, and also sends invites/notifications. If email isn't configured, users **cannot log in** — the send fails and the app logs a warning at startup. Configure SMTP or SES before going live.

Works with: **Mailgun, Postmark, SendGrid, Amazon SES, or any SMTP server.**

Configure in `.env.prod`:

**SMTP (most providers):**
```
MAIL_PROVIDER=smtp
MAIL_FROM_ADDRESS=noreply@your-domain.com
# Blank follows the instance branding name; set it to pin a fixed one.
MAIL_FROM_NAME=
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_USE_TLS=true
```

**AWS SES:**
```
MAIL_PROVIDER=ses
MAIL_FROM_ADDRESS=noreply@your-domain.com
# Blank follows the instance branding name; set it to pin a fixed one.
MAIL_FROM_NAME=
AWS_MAIL_ACCESS_KEY_ID=YOUR_KEY
AWS_MAIL_SECRET_ACCESS_KEY=YOUR_SECRET
AWS_MAIL_REGION=us-east-1
```

---

## Configuration Reference

All environment variables are documented in [`.env.example`](../.env.example). Key settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `REDIS_URL` | Redis connection string | (required) |
| `S3_STORAGE` | `s3` for native AWS S3; any other value (e.g. `minio`) for every other S3-compatible store | `minio` |
| `S3_BUCKET` | S3 bucket name | (required) |
| `S3_ENDPOINT` | S3 endpoint the API and workers use (non-AWS); ignored when `S3_STORAGE=s3` | `http://minio:9000` |
| `S3_PUBLIC_ENDPOINT` | Browser-reachable base URL for presigned URLs, when it differs from `S3_ENDPOINT` | (empty = `S3_ENDPOINT`) |
| `S3_STORAGE_CLASS` | Storage class for media (uploaded originals, every transcoder output and watermarked renders), set by the server when each object is created. Avatars, logos and posters keep the bucket default. MinIO and Silo accept only `STANDARD` and `REDUCED_REDUNDANCY`; Garage ignores it; `GLACIER` and `DEEP_ARCHIVE` are refused at startup | (empty = bucket default) |
| `CORS_ALLOW_ORIGINS` | Extra browser origins, comma-separated, allowed by the API and (non-AWS) the bucket | (empty) |
| `JWT_SECRET` | Auth token signing key | (required, generate with `openssl rand -hex 64`) |
| `FRONTEND_URL` | Your FreeFrame URL (with https://) | (required) |
| `DOMAIN` | Your domain; required with `docker-compose.https.yml`, which requests the certificate | (optional) |
| `ACME_EMAIL` | Email for Let's Encrypt notifications; required with `docker-compose.https.yml` | (optional) |
| `MAIL_PROVIDER` | `smtp` or `ses` | `smtp` |
| `API_WORKERS` | Gunicorn worker processes | `4` |
| `TRANSCODING_CONCURRENCY` | Parallel transcoding jobs | `2` |
| `EMAIL_CONCURRENCY` | Parallel email jobs | `2` |
| `MAINTENANCE_CONCURRENCY` | Parallel housekeeping jobs | `1` |
| `CELERY_LOGLEVEL` | Log level of the Celery workers and beat. At `warning` they still log what the retention GC, stale-upload reaper and orphan sweep deleted, and any sweep that is switched off | `info` |
| `UPLOAD_CONCURRENCY` | Upload parts in flight across the whole browser tab, shared by every file being uploaded (the earliest file first), not per file. Values above 6 only help when the storage endpoint speaks HTTP/2: over HTTP/1.1 a browser opens at most 6 connections per host, shared by all its tabs, so parts past the sixth wait for a free connection before they send anything, which with large parts on a slow uplink can be minutes. The upload leaves such a waiting part alone while other parts in the tab are sending, and gives up on it (and retries it) only after 5 minutes without a first byte. Read when the web container starts, so changing it needs `docker compose ... up -d web` with the same `--env-file` and every `-f` file you start FreeFrame with (`docker compose restart` does not re-read `.env.prod`), not a rebuild. The older name `NEXT_PUBLIC_UPLOAD_CONCURRENCY` is still read when this one is unset | `5` |
| `TRANSCODER_PIPELINE` | GPU backend: `Auto`, `NVIDIA`, `Intel`, or `Software` | `Auto` |
| `TRANSCODER_OUTPUT` | Output codec: `h264_8` (broad compatibility) or `h265_10` (HEVC 10-bit) | `h264_8` |
| `TRANSCODER_HDR` | `convert` (tone-map HDR to SDR) or `preserve` (keep HDR tags) | `convert` |
| `TRANSCODER_QUALITIES` | Ladder rungs to build: any of `2160p`, `1080p`, `720p`, `360p`. A rung names the source's short side, so portrait video is sized like landscape (1080x1920 under `1080p` keeps its size). Rungs above the source are dropped, and if that leaves none the smallest is built at the source's own size, so `2160p` alone gives one rendition at source size for anything up to 4K | `1080p,720p,360p` |
| `TRANSCODER_CRF_OFFSET` | Fallback for the **Compression** slider in Admin Dashboard → Instance settings → Review streams, which sets the same thing in the app and wins once an admin has moved it, and which an admin can hand back with **Use server default**. A whole number of CRF steps from `-12` to `12`; negative is better quality and bigger files, and about six steps is a doubling of bitrate. `0` leaves the encode byte-identical to what it was. The ladder's own numbers suit ordinary review footage; graded work with large dark gradients bands visibly at the default top rung of CRF 24, and `-8` puts the default software x264 8-bit ladder on CRF 16 / 18 / 22 (the slider's *Highest quality*); measured on one 1080p dark-gradient master, its top rung went from about 0.8 to about 1.5 Mbit/s. Those numbers are the **default software x264 8-bit ladder**: a 10-bit `TRANSCODER_OUTPUT` (`h265_10`) already encodes 8 CRF steps lower, so `-8` means CRF 8 / 10 / 14 there, and the hardware backends start from their own numbers (`-global_quality` 12 / 14 / 18 on QSV and VAAPI, and NVENC shifts its constant qp). It shifts every backend by the same number of steps, whatever quality option that backend uses (CRF on libx264/libx265, `-global_quality` on QSV and VAAPI, `-qp` on NVENC); a negative value additionally switches software H.264 to `-aq-mode 3`, which biases bits toward dark areas, and no `-aq-mode` is added at `0` and above. Only new transcodes are affected; existing videos keep their renditions until a new version is uploaded. Changing it needs both the `api` and the `worker` container recreated, because each reads the environment at start. An unusable value is logged and ignored | `0` |
| `TRANSCODER_AUDIO_BITRATE` | AAC bitrate for the audio of video review streams, as `<n>k` between `64k` and `512k` (for example `320k` for music and final-mix review). Empty leaves ffmpeg's own choice, AAC-LC at about 128 kb/s for stereo. The value is the total for all channels, and ffmpeg's default for a surround source is already higher (about 341 kb/s for 5.1 and 469 kb/s for 7.1), so a stereo-sized value such as `320k` lowers surround quality. The codec is always AAC-LC, the one every browser plays over HLS. Applies to every rendition, so storage grows by the extra bitrate times the number of rungs. A source-copied upload whose audio is already AAC keeps its own audio untouched; non-AAC audio in a copy is encoded at this bitrate, or `192k` when it is empty. An unusable value is logged and ignored | *(empty)* |
| `TRANSCODER_SOURCE_COPY` | Package an already browser-safe source into HLS without re-encoding, where the ladder above resolves to one rendition at the source's own size | `false` |
| `TRANSCODER_CPU_LIMIT` | Cap the CPU one transcode takes: a core count (`6`) or a share of what the process may use (`50%`). Empty = unbounded. Covers the encoders and the filter graph, not decoding, so a heavy master can run over by roughly a quarter, and a low budget can push a long master past ffmpeg's 4-hour ceiling — see `.env.example`. Per ffmpeg process, so the machine-wide ceiling is this times `TRANSCODING_CONCURRENCY` | *(empty)* |

Upload part size is set in the app rather than the environment: **Admin Dashboard → Instance settings → Uploads**. Automatic (the default) keeps 10 MB parts up to ~5 GB and grows them for bigger files to about 500 parts, which keeps the storage backend's assembly at the end of an upload short. Fixed cuts every upload into one size from 5 to 512 MB, and refuses a file that would need more than 10,000 parts. A completion that takes 5 seconds or more is logged by the API with where the time went (`completing upload … took …`), which is the place to look when uploads wait at "Finalizing".

Uploads wait in a queue. Files dropped or picked together start in the order they were added, with up to three files active at a time, and the earliest file gets the bandwidth first, so a lost connection leaves whole finished files rather than many half-sent ones. `UPLOAD_CONCURRENCY` is the one budget of upload parts those files share: it used to apply to each file on its own, so with several files uploading at once a tab now sends no more parts than the setting says, where it used to send that many per file. If you raised it to speed up a single large file, it still does. If storage is unreachable when a file's turn comes, the queue pauses (the Uploads panel says "Waiting for storage" or "Waiting for connection") and carries on by itself when it answers again.

Who may download originals is also set in the app: **Admin Dashboard → Instance settings → Downloads**. *Transcode only* (the default) gives share-link visitors, visitors to a public project and people an asset is shared with directly the transcode (a video's MP4, an audio file's MP3, an image's WebP), as earlier releases did; a video with no MP4 still downloads its original. *Original or transcode* lets them pick the original too. Project members can always pick the original one asset at a time. Bulk downloads (a selection on the project page, Download All on a share link) follow this setting for everyone: originals when it is on, transcodes when it is off. Camera masters can be many times the size of the transcode, so turning it on can raise storage egress considerably.

---

## Scaling

### API Workers

The `API_WORKERS` env var controls how many gunicorn worker processes handle API requests. A good starting point:

```
API_WORKERS = (2 x CPU cores) + 1
```

### Transcoding Workers

Video transcoding is CPU-intensive. Adjust `TRANSCODING_CONCURRENCY` based on your server:

| Server | Recommended |
|--------|-------------|
| 2 cores | 1-2 |
| 4 cores | 2-3 |
| 8+ cores | 4-6 |

### Hardware-Accelerated Transcoding (optional)

FreeFrame can use an NVIDIA (NVENC) or Intel (VAAPI) GPU to transcode faster, and
automatically falls back to software (CPU) transcoding if no GPU is present or a
hardware attempt fails at runtime. This is entirely opt-in: the default build and
default runtime behavior are unchanged.

The [installer](#video-processing-on-a-gpu) finds an NVIDIA GPU, offers to use it and
does the steps below for you. By hand:

**NVIDIA, with the published images.** The published API image needs nothing more:
its ffmpeg has NVENC, which uses the host's driver.

1. Install the NVIDIA driver on the host and check that `nvidia-smi` answers. On
   WSL2, install the NVIDIA driver for Windows; nothing is installed inside WSL.
2. Install the NVIDIA Container Toolkit and set Docker up for it, as NVIDIA's
   [install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
   describes. On Ubuntu and Debian:

   ```bash
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
     sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
   curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
     sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
     sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
   sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

   Restarting Docker stops every container on the host for a moment.
3. Add `-f docker-compose.gpu.yml` to the `-f` files you already use, for every
   command. It gives only the `worker` service (the transcoding queue) one NVIDIA GPU,
   with the `video` driver capability NVENC needs, and sets `TRANSCODER_PIPELINE` to
   `NVIDIA` unless `.env.prod` sets it:

   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.images.yml \
     -f docker-compose.gpu.yml up -d
   ```

4. Check that the worker sees the GPU:

   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.images.yml \
     -f docker-compose.gpu.yml exec worker nvidia-smi -L
   ```

To go back to the CPU, leave `-f docker-compose.gpu.yml` out and run `up -d` again.

**Intel (VAAPI).** This needs an image you build yourself:

1. Build the API image with `--build-arg ENABLE_HWACCEL=true` (see
   [Build from source](#build-from-source)).
2. Pass `/dev/dri` through to the `worker` service.
3. Set `TRANSCODER_PIPELINE` to `Intel`, or leave it as `Auto` to detect it.

If you build the `2160p` rung, a GPU is worth it: a 4K encode takes about four times
the CPU of a 1080p one. A master that is already H.264 8-bit 4:2:0 can skip the
encode entirely with `TRANSCODER_SOURCE_COPY=true` and a single-rung ladder, but most
4K camera and NLE exports (HEVC, 10-bit, HDR, ProRes) cannot, and are always encoded.
The GPU decoders don't handle ProRes, DNxHR, 10-bit H.264, or 4:2:2 H.264 or HEVC.
For those masters, on NVIDIA and Intel, the decode stays on the CPU and the frames
are uploaded, so scaling and encoding still run on the GPU. Expect the CPU decode
to be the bottleneck on 4K ProRes. Video with a display rotation (most portrait
phone footage) has to be turned upright in system memory: on NVIDIA it is still
decoded on the GPU and passed through system memory, which costs a little CPU; on
Intel it is decoded on the CPU.

### Email Workers

Email sending is I/O-bound and lightweight. The default of `2` is sufficient for most deployments.

### Maintenance Workers

Housekeeping is I/O-bound but can run long: `cleanup_soft_deleted` deletes S3
objects one at a time and `sweep_orphan_s3` lists the whole bucket. The default
of `1` is right for most deployments, since these tasks are scheduled hourly at
most and none of them is latency-sensitive. Raising it mainly helps if you have
a large backlog of soft-deleted media to reclaim.

---

## Monitoring

### Health Check

The API exposes a health endpoint:

```
GET /health → { "status": "ok" }
```

Use this for uptime monitoring (UptimeRobot, Healthchecks.io, etc.) or Docker health checks.

### Logs

```bash
# Follow all service logs
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f

# Follow a specific service
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api

# Last 100 lines
docker compose --env-file .env.prod -f docker-compose.prod.yml logs --tail 100 api
```

### Key Metrics to Watch

| Metric | How to Check | Warning Sign |
|--------|-------------|--------------|
| Disk space | `df -h` | > 80% used |
| Memory | `free -m` | Swap in use |
| API response | `curl -s localhost/health` | Non-200 response |
| Queue depth | `docker compose --env-file .env.prod -f docker-compose.prod.yml exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LLEN transcoding'` (repeat for `email_high`, `email_low`, `maintenance`, `default`) | Any queue growing steadily; **any depth at all on `default`** |
| Busy workers | `docker compose --env-file .env.prod -f docker-compose.prod.yml exec api celery -A apps.api.tasks.celery_app inspect active` | Tasks stuck for hours |
| Database connections | `docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres psql -U freeframe -c "SELECT count(*) FROM pg_stat_activity;"` | > 80% of max |

Check depth with `LLEN`, not `inspect active`. `inspect active` reports what
connected workers are executing right now, so a queue that no worker subscribes
to shows up as nothing at all: the workers are genuinely idle while the backlog
grows unseen. That is exactly how [#240](https://github.com/Techiebutler/freeframe/issues/240)
went unnoticed.

`REDIS_PASSWORD` lives in `.env.prod`, which is not exported into your shell,
so it has to expand inside the container. That is why the command above is
wrapped in `sh -c '...'` with single quotes rather than passing `-a "$REDIS_PASSWORD"`
directly, which would authenticate with an empty password.

`default` should always be empty. Every task is routed explicitly, so anything
landing there is a task that was added without a route and that no worker will
ever run.

### Queue Topology

Each worker subscribes to an explicit `-Q` list, so a task whose queue has no
subscriber is silently never executed. The shipped topology is:

| Queue | Consumed by | Carries |
|-------|-------------|---------|
| `transcoding` | `worker` | Video/audio/image processing, metadata backfill, watermarking |
| `email_high` | `email_worker` | Magic codes, invites |
| `email_low` | `email_worker` | Mentions, comments, approvals, share notices |
| `maintenance` | `maintenance_worker` | Retention GC, stale-upload reaper, orphan sweep |
| `default` | nobody, by design | Should always be empty |

If you add a task, route it in `apps/api/tasks/celery_app.py` to one of the
consumed queues. `apps/api/tests/test_celery_queue_topology.py` fails if a
registered task routes somewhere no compose worker consumes.

---

## Backups

### Database Backup

```bash
# One-time backup
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  pg_dump -U freeframe freeframe | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz

# Restore from backup
gunzip -c backup_20260403_120000.sql.gz | \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U freeframe freeframe
```

### Automated Daily Backups

Add a cron job on your server:

```bash
# Edit crontab
crontab -e

# Add this line (runs daily at 2 AM, keeps 30 days)
0 2 * * * cd /path/to/freeframe && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres pg_dump -U freeframe freeframe | gzip > /path/to/backups/freeframe_$(date +\%Y\%m\%d).sql.gz && find /path/to/backups -name "freeframe_*.sql.gz" -mtime +30 -delete
```

### S3 Media Backup

Your media files are already in S3. For redundancy:

- **AWS S3**: Enable [versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) and [cross-region replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- **Cloudflare R2**: Use [Sippy](https://developers.cloudflare.com/r2/data-migration/sippy/) for incremental migration/backup
- **Self-hosted Silo or MinIO**: Use [`mc mirror`](https://min.io/docs/minio/linux/reference/minio-mc/mc-mirror.html) to replicate to a second location

### What to Back Up

| Data | Location | Priority |
|------|----------|----------|
| Database | PostgreSQL | **Critical** — all users, projects, comments, share links |
| Media files | S3 bucket | **Important** — uploaded assets and transcoded files |
| Environment config | `.env.prod` | **Important** — save a copy outside the server |
| SSL certificates | `letsencrypt/` volume | Low: with HTTPS on (`docker-compose.https.yml`, or the installer's HTTPS), Traefik renews them on its own |

---

## Updating

**Running the published images:** download the compose files again from the same ref (they name the release they belong to, and a new release can add services), then pull and restart:

```bash
cd freeframe
( set -e; for f in docker-compose.prod.yml docker-compose.images.yml; do
    curl -fsSLO "https://raw.githubusercontent.com/Techiebutler/freeframe/latest/$f" \
      || { echo "Could not download $f: check the ref." >&2; exit 1; }
  done ) \
  && docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.images.yml pull \
  && docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.images.yml up -d
```

Download `docker-compose.https.yml` and `docker-compose.storage.yml` again too if you use them, and keep their `-f` flags in both commands. If you set `FREEFRAME_VERSION` in `.env.prod`, change it to the version you want (or remove it to follow the downloaded file). Keep your own changes in an extra `-f` file rather than editing the downloaded ones, so downloading again does not overwrite them.

**Building from source** (unchanged):

```bash
cd freeframe
git pull origin main
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically on API startup. Always check the [CHANGELOG](../CHANGELOG.md) before updating.

### Upgrading past the maintenance-queue fix ([#240](https://github.com/Techiebutler/freeframe/issues/240))

Before this fix, no worker consumed the `default` queue, so the retention GC,
the stale-upload reaper, the orphan sweeper, due-date reminders and
`apply_watermark` were published and never executed. This release adds a
`maintenance_worker` service, so **`docker compose up -d --build` alone is not
enough: you must be using the updated compose file** for the new service to
exist.

Two things to do once, in this order.

**1. Check what the first garbage-collection run will delete.** The GC has never
run on your instance, so its first pass reclaims everything already past the
retention window, all at once. Count it first, substituting your own
`SOFT_DELETE_RETENTION_DAYS` for the `30` below:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U freeframe -c "
WITH cutoff AS (SELECT now() - interval '30 days' AS t)
SELECT 'projects'        AS root, count(*) FROM projects,        cutoff WHERE deleted_at < t
UNION ALL SELECT 'folders',        count(*) FROM folders,        cutoff WHERE deleted_at < t
UNION ALL SELECT 'assets',         count(*) FROM assets,         cutoff WHERE deleted_at < t
UNION ALL SELECT 'asset_versions', count(*) FROM asset_versions, cutoff WHERE deleted_at < t
UNION ALL SELECT 'comments',       count(*) FROM comments,       cutoff WHERE deleted_at < t
UNION ALL SELECT 'share_links',    count(*) FROM share_links,    cutoff WHERE deleted_at < t
UNION ALL SELECT 'live assets swept in with a deleted project/folder',
       count(*) FROM assets a, cutoff
       WHERE a.deleted_at IS NULL AND (
         a.project_id IN (SELECT id FROM projects WHERE deleted_at < cutoff.t)
         OR a.folder_id IN (SELECT id FROM folders WHERE deleted_at < cutoff.t));"
```

That last row is the one that surprises people. Deleting a project sets
`deleted_at` on the project row only, and does **not** cascade to its assets, but
the purge removes every asset belonging to a purged project or folder regardless
of the asset's own `deleted_at`. So a project you trashed months ago still counts
its live assets here even though they look untouched.

If any of these numbers is larger than you expect, raise
`SOFT_DELETE_RETENTION_DAYS` (or set it to `0` to keep the GC off) before
starting the new worker, and lower it once you have reviewed what would go. The
deletion is a hard delete with S3 reclaim and is not recoverable.

**2. Drop the stale `default` backlog.** Instances that ran `beat` accumulated
roughly 49 orphaned messages a day. The new worker consumes `maintenance`, not
`default`, so the backlog is inert and safe to leave, but it wastes Redis
memory:

```bash
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" LLEN default
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" RENAME default default-old-240
```

`RENAME` rather than `DEL` so the messages can be inspected or restored. Delete
`default-old-240` once the new worker is running and `LLEN maintenance` is
draining normally.

### Upgrading past the media-metadata fix ([#124](https://github.com/Techiebutler/freeframe/issues/124))

If you're upgrading past the media-metadata fix ([#124](https://github.com/Techiebutler/freeframe/issues/124)), backfill missing `duration_seconds`/`width`/`height`/`fps` on already-processed files with: `docker exec freeframe-api-1 python -m apps.api.scripts.backfill_media_metadata`. The backfill runs as a Celery task on the `transcoding` queue, so it occupies one worker slot and can run long on large libraries (up to ~300s per file); new uploads keep transcoding normally on the remaining slots.

### Upgrading past the storage image switch ([#461](https://github.com/Techiebutler/freeframe/issues/461))

Only for deployments that run the optional self-hosted storage block in `docker-compose.prod.yml`. The `minio/minio` and `minio/mc` images can no longer be pulled from Docker Hub, so the block now runs Silo, a maintained fork of MinIO. A cached `minio/minio` image keeps working if you don't switch, but it can't be pulled again.

1. In your compose file, replace `minio/minio:...` with `pgsty/silo:RELEASE.2026-09-16T00-00-00Z` and `minio/mc:latest` with `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`, and delete the four `MINIO_CORS_*` lines (MinIO never read them).
2. Keep the service name `minio` and the `miniodata` volume. Silo opens the existing data as is, and the old image can still read it if you roll back.
3. Silo enforces the bucket CORS rules FreeFrame writes at startup, which MinIO ignored. Make sure `FRONTEND_URL` is the exact origin people browse to, and put any other browser origin in `CORS_ALLOW_ORIGINS`. If your `.env.prod` sets `MINIO_CORS_ALLOW_ORIGIN`, move that value to `CORS_ALLOW_ORIGINS`.
4. `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d`

### Upgrading past the storage measurement ([#599](https://github.com/Techiebutler/freeframe/pull/599))

Only matters if your instance has a storage limit set (**Settings → Admin → Instance settings → Storage limit (GB)**, `storage_limit_bytes`; `0` is unlimited). With no limit, nothing here can refuse an upload and you can skip to step 4.

Used storage now has one definition everywhere, and it counts two things it did not count before: **the trash**, from the moment the new API starts, and **what the transcoder wrote**, once the backfill has measured it. Nothing is deleted and no object moves; the bucket was always this full. But the number the cap is enforced against goes up, and on a near-full instance the first increase arrives before you have run anything.

**1. Before you upgrade, find out what the trash will add.** Trashed assets and versions were left out of the old figure and are counted from the new API's first start. A live asset inside a trashed project was already counted, so it adds nothing.

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U freeframe -c "
SELECT pg_size_pretty(sum(mf.file_size_bytes))                   AS originals_counted_after_upgrade,
       pg_size_pretty(coalesce(sum(mf.file_size_bytes) FILTER (
           WHERE a.deleted_at IS NOT NULL
              OR v.deleted_at IS NOT NULL), 0))                  AS added_by_the_trash
  FROM media_files mf
  JOIN asset_versions v ON v.id = mf.version_id
  JOIN assets        a ON a.id = v.asset_id
  JOIN projects      p ON p.id = a.project_id
 WHERE v.processing_status IN ('processing', 'ready');"
```

`originals_counted_after_upgrade` is the figure the cap will be enforced against once the new API starts, and `added_by_the_trash` is how much of it is new. If that figure is close to your limit, raise the limit **before** you upgrade. Deleting something is not a remedy any more: the figure stays where it is until the retention collector reclaims the objects, 30 days after the delete by default (`SOFT_DELETE_RETENTION_DAYS`) and never with `SOFT_DELETE_RETENTION_DAYS=0`, which switches the collector off. `POST /admin/purge` uses the same cutoff.

**2. Upgrade, with the maintenance worker recreated alongside the API.** The backfill is a new Celery task on the `maintenance` queue, and a worker still running the old code does not know it: the worker rejects a queued backfill and that run is lost, and recreating the worker afterwards does not bring it back. If you triggered it too early, trigger it again once the worker is recreated.

```bash
git pull origin main
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

The migration (`f4b9c2a7d105`) adds a nullable `media_files.derived_size_bytes` and a unique constraint on `media_files.version_id`. It runs in one transaction, so if your database somehow holds two media files for one version it names them, changes nothing at all and tells you which row to keep.

**3. Run the backfill once, then re-check the limit.** It does one bucket listing per unmeasured version, is idempotent, resumable and safe to run while the instance is serving, and it pauses between batches. There is no button for it in this release. On the server it needs no token:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  exec api celery -A apps.api.tasks.celery_app call backfill_media_derived_size
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  logs -f maintenance_worker
```

The worker logs `backfill_media_derived_size: measured=... failed=... bytes=... stopped=...` when it finishes. `failed` counts listings the object store refused; those rows stay unmeasured and a later run picks them up. `stopped=listing_failures` means several listings failed in a row and it gave up, which almost always means the store is unreachable: fix that and run it again.

Over the API instead, with an access token for a superadmin account (the production compose serves the API under `/api` and disables the interactive docs page):

```bash
TOKEN='<a superadmin access token>'
curl -fsS -X POST https://your-freeframe.example/api/admin/storage/backfill \
  -H "Authorization: Bearer $TOKEN"
curl -fsS https://your-freeframe.example/api/admin/storage \
  -H "Authorization: Bearer $TOKEN"
```

A 202 means enqueued, not finished, and calling it twice does not run it twice. Read the overview again until `unmeasured_files` reaches 0. Without the API, the same three numbers from `psql`:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U freeframe -c "
SELECT pg_size_pretty(sum(mf.file_size_bytes)
                      + coalesce(sum(mf.derived_size_bytes), 0))  AS used,
       pg_size_pretty(coalesce(sum(mf.file_size_bytes
                      + coalesce(mf.derived_size_bytes, 0)) FILTER (
           WHERE p.deleted_at IS NOT NULL
              OR a.deleted_at IS NOT NULL
              OR v.deleted_at IS NOT NULL), 0))                   AS of_which_in_the_trash,
       count(*) FILTER (WHERE mf.derived_size_bytes IS NULL)      AS unmeasured_files
  FROM media_files mf
  JOIN asset_versions v ON v.id = mf.version_id
  JOIN assets        a ON a.id = v.asset_id
  JOIN projects      p ON p.id = a.project_id
 WHERE v.processing_status IN ('processing', 'ready');"
```

How much the transcode output adds depends entirely on your media. Measured on 10 second synthetic 1080p clips through the default ladder, with the top rung stored twice as `download.mp4` by design, derived output came to between 0.16x and 2.84x the original, largest for already-compressed sources because CRF output follows the picture rather than the source bitrate. Synthetic clips are not footage, so treat that as a range and not as a prediction; the figure for your own library is the one the backfill produces. Then compare `used` with your limit and raise it if the new figure is close.

**4. New uploads need none of this.** Every transcode from now on measures its own output when it finishes. A transcode whose bookkeeping listing failed leaves the row unmeasured, which is what `unmeasured_files` reports; nothing re-measures it on a schedule, so run the backfill again if that count grows. The cap is soft by one transcode, because the upload guard is given the incoming original only.

### Update Checklist

1. **Read the changelog** — check for breaking changes or new env vars
2. **Backup the database** — `pg_dump` before updating (see [Backups](#backups))
3. **Pull and rebuild**: published images: download the compose files again, then `docker compose pull && docker compose up -d`; from source: `git pull && docker compose up -d --build`
4. **Verify** — check `/health`, test login, spot-check a share link
5. **Rollback if needed**: published images: set `FREEFRAME_VERSION=1.x.x` in `.env.prod` (no leading `v`), then `docker compose pull && docker compose up -d`; from source: `git checkout v1.x.x && docker compose up -d --build`

---

## Troubleshooting

### Services not starting

```bash
# Check logs for a specific service
docker compose --env-file .env.prod -f docker-compose.prod.yml logs api
docker compose --env-file .env.prod -f docker-compose.prod.yml logs worker
docker compose --env-file .env.prod -f docker-compose.prod.yml logs web
docker compose --env-file .env.prod -f docker-compose.prod.yml logs traefik

# Check all service statuses
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

### `failed to resolve reference ... not found`

With `docker-compose.images.yml`, a version that has no published image prints `failed to resolve reference ghcr.io/techiebutler/freeframe-api:<version>: ... not found`, followed by an error about the build context (the build section of `docker-compose.prod.yml` needs the source tree, which you do not have). Read the pair as "that version is not published". Check `FREEFRAME_VERSION` in `.env.prod` (digits and dots only, no leading `v`) and that the compose files you downloaded belong to v1.22.0 or a later release. A new release's images can take a little while to appear after the release itself.

You must build yourself when you deploy under a sub-path (`NEXT_PUBLIC_BASE_PATH`), use Intel (VAAPI) transcoding, or run local changes. NVIDIA (NVENC) transcoding works with the published images and `docker-compose.gpu.yml`; see [Hardware-Accelerated Transcoding](#hardware-accelerated-transcoding-optional). Clone the repository and run `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build` without `docker-compose.images.yml`. Adding `--build` to a command that does include the images file also builds from source, but it needs the source tree next to the compose file.

### Database migration failures

```bash
# Run migrations manually
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic upgrade head"

# Check migration status
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic current"
```

### SSL certificate not working

- Verify you started with `-f docker-compose.prod.yml -f docker-compose.https.yml`; the base file alone never requests a certificate
- Verify `DOMAIN` and `ACME_EMAIL` are set in `.env.prod`
- Check that DNS A record points to your server: `dig your-domain.com`
- Ensure ports 80 and 443 are open: `sudo ufw allow 80,443/tcp`
- Check Traefik logs: `docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.https.yml logs traefik`
- Let's Encrypt has rate limits — if you hit them, wait an hour and retry

### S3 connection issues

- Verify your credentials are correct in `.env.prod`
- Ensure your bucket exists and has proper CORS configuration
- For non-AWS providers, double-check the `S3_ENDPOINT` URL
- **Uploads stuck at 0%, with a browser `NetworkError` / `Failed to fetch` on the part `PUT`:** on a self-hosted or S3-compatible store the bucket's CORS allows only `FRONTEND_URL`'s origin, `http://localhost:3000`/`3001` and `CORS_ALLOW_ORIGINS`. Check that `FRONTEND_URL` matches the address bar exactly (scheme, host and port), then recreate the API (`docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --force-recreate api`) so it rewrites the rules. Then check that `S3_PUBLIC_ENDPOINT` is reachable from the browser and is `https://` when FreeFrame is.

### Port 80/443 already in use

```bash
# Find what's using the port
sudo lsof -i :80
# Stop that service or change the port mapping in docker-compose.prod.yml
```

### Large file uploads failing

Large media files are uploaded directly to S3 via presigned URLs (bypassing Traefik), so proxy limits don't apply to file data. If uploads still fail:
- Check that your S3 bucket doesn't have a size limit
- Verify your server has enough `/tmp` space for transcoding
- Check worker logs for processing errors
