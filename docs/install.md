# Installing Media Ops

Media Ops runs in Docker, so it works almost anywhere Docker does. Pick your system below.
Each guide ends the same way: open `http://<that-computer's-ip>:8484` in a browser and follow
[First steps](../README.md#first-steps) in the README.

- [Unraid](#unraid)
- [TrueNAS](#truenas)
- [Linux](#linux) (Ubuntu, Debian, Fedora, Raspberry Pi OS and the rest)
- [Windows](#windows)
- [macOS](#macos)
- [Synology](#synology)
- [QNAP](#qnap)
- [Portainer, Proxmox and others](#portainer-proxmox-and-others)
- [Reaching your apps](#reaching-your-apps): what address to type for Plex, Sonarr and the rest
- [Updating](#updating)

**What you need:** Docker, a 64-bit system (Intel/AMD or ARM, like a Raspberry Pi 4 or 5 or an
Apple Silicon Mac), and a free port 8484.

---

## Unraid

1. Save [`unraid-template.xml`](../unraid-template.xml) to your flash drive as
   `/boot/config/plugins/dockerMan/templates-user/my-media-ops.xml`.
2. Go to **Docker → Add Container**, pick **media-ops** from the template list, and click
   **Apply**.
3. Open `http://<your-unraid-ip>:8484`.

The template already maps your array and cache so their free space shows up, and the Docker
socket so you see your containers. Add **Unraid** under Settings → Add app to see the array,
parity and disk temperatures (see the [README](../README.md#setting-up-unraid-or-truenas)).

## TrueNAS

TrueNAS 24.10 or newer.

1. Make a dataset for Media Ops' settings, for example `tank/apps/media-ops`, and give the
   `apps` user (ID 568) permission to write to it.
2. Go to **Apps → Discover Apps → ⋮ → Install via YAML** and paste in
   [`truenas-compose.yml`](truenas-compose.yml). Change `tank` to your pool's name.
3. Open `http://<your-truenas-ip>:8484`. Under **Settings → General → Disks to show**, enter
   your pool, like `/mnt/tank`.

## Linux

Any distribution with Docker works. If you don't have Docker yet, the quickest way on most
systems is `curl -fsSL https://get.docker.com | sh`.

**With Docker Compose (recommended).** Make a folder, put
[`docker-compose.yml`](../docker-compose.yml) in it, and change the few lines marked in it:

```bash
mkdir ~/media-ops && cd ~/media-ops
curl -fsSLO https://raw.githubusercontent.com/KaiserHomeLab/media-ops/main/docker-compose.yml
nano docker-compose.yml        # set PUID/PGID, TZ and your disks
docker compose up -d
```

**Or with one command:**

```bash
docker run -d --name media-ops --restart unless-stopped -p 8484:8484 \
  -e PUID=$(id -u) -e PGID=$(id -g) -e TZ=America/Chicago -e HOST_NAME=$(hostname) \
  -v ~/media-ops:/config \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /mnt/media:/mnt/media:ro \
  ghcr.io/kaiserhomelab/media-ops:latest
```

Change `/mnt/media` to wherever your media lives (add one `-v` per disk), then list the
right-hand side under Settings → General → Disks to show.

**Things that trip people up on Linux:**

- **PUID and PGID** are the user Media Ops runs as, so it can write its settings folder. Run
  `id` and use your own numbers (usually `1000`).
- **Can't open the page from another device?** Your firewall may be blocking the port.
  Ubuntu/Debian: `sudo ufw allow 8484/tcp`. Fedora/RHEL: `sudo firewall-cmd --add-port=8484/tcp --permanent && sudo firewall-cmd --reload`.
- **Fedora, RHEL, Rocky or Alma (SELinux):** add `:Z` to the settings folder, like
  `-v ~/media-ops:/config:Z`, or the container can't write to it.
- **Rootless Docker or Podman:** the Docker socket lives somewhere else. Use
  `-v $XDG_RUNTIME_DIR/docker.sock:/var/run/docker.sock:ro` (rootless Docker) or
  `-v /run/podman/podman.sock:/var/run/docker.sock:ro` (Podman, after
  `sudo systemctl enable --now podman.socket`). Everything else is the same.
- **GPU load:** Intel and AMD GPUs show up on their own. For Nvidia, install the Nvidia
  Container Toolkit and add `--gpus all` (or `runtime: nvidia` in Compose).
- **Raspberry Pi:** use the 64-bit Raspberry Pi OS. The 32-bit one isn't supported.

## Windows

Windows 10 or 11 with [Docker Desktop](https://www.docker.com/products/docker-desktop/).

1. Install Docker Desktop and keep the default **Use WSL 2** setting. Start it and wait until it
   says it's running. (It must be in **Linux containers** mode, which is the default.)
2. Open **PowerShell** and run:

   ```powershell
   docker run -d --name media-ops --restart unless-stopped -p 8484:8484 `
     -e TZ=America/Chicago -e HOST_NAME=$env:COMPUTERNAME `
     -v C:\media-ops:/config `
     -v /var/run/docker.sock:/var/run/docker.sock:ro `
     -v D:\Media:/mnt/media:ro `
     ghcr.io/kaiserhomelab/media-ops:latest
   ```

   Change `D:\Media` to the folder that holds your media (add one `-v` line per drive), and
   `America/Chicago` to [your time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).
   PowerShell uses a backtick `` ` `` at the end of each line, not `\`.
3. Open `http://localhost:8484` on this PC, or `http://<this-pc's-ip>:8484` from another device.
   If Windows asks whether Docker may use the network, click **Allow**.
4. Under **Settings → General → Disks to show**, enter `/mnt/media`. It shows the free space of
   the whole drive.

You can also use [`docker-compose.yml`](../docker-compose.yml): save it in a folder, edit it, and
run `docker compose up -d` from that folder in PowerShell.

**Good to know on Windows:**

- **Apps installed on the same PC** (like Plex for Windows) are at `host.docker.internal`, so
  Plex is `http://host.docker.internal:32400`. Never use `localhost`; see
  [Reaching your apps](#reaching-your-apps).
- **CPU and memory** on the dashboard are Docker's own small Linux VM, not the whole PC. The
  dashboard labels them "Docker VM". You can give Docker more under Docker Desktop → Settings →
  Resources.
- **Start with Windows:** turn on **Start Docker Desktop when you sign in** in Docker Desktop's
  settings. `--restart unless-stopped` starts Media Ops when Docker starts.
- **GPU load** only shows for Nvidia cards, and only if you add `--gpus all`.
- **Your settings** are in `C:\media-ops`. To reset the password, open
  `C:\media-ops\password-reset.txt` after asking for a code (see the
  [README](../README.md#forgot-your-password)).

## macOS

macOS with [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
[OrbStack](https://orbstack.dev/), on an Intel or Apple Silicon Mac. Open **Terminal** and run:

```bash
docker run -d --name media-ops --restart unless-stopped -p 8484:8484 \
  -e TZ=America/Chicago -e HOST_NAME=$(scutil --get ComputerName | tr ' ' '-') \
  -v ~/media-ops:/config \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /Volumes/Media:/mnt/media:ro \
  ghcr.io/kaiserhomelab/media-ops:latest
```

Change `/Volumes/Media` to your media drive, then enter `/mnt/media` under Settings → General →
Disks to show. Like on Windows, apps installed on the Mac itself are at
`host.docker.internal`, and CPU and memory are Docker's VM, not the whole Mac.

## Synology

DSM 7.2 or newer, with **Container Manager** installed from the Package Center.

1. In **File Station**, make a folder `docker/media-ops` (the `docker` shared folder is created
   when you install Container Manager).
2. Find your user's ID: in **Control Panel → Terminal & SNMP**, turn on SSH, connect, and run
   `id`. You want the `uid` and `gid` numbers. (Or use `PUID=1026` and `PGID=100`, the usual
   values for the first account.)
3. In **Container Manager → Project → Create**, name it `media-ops`, choose the
   `docker/media-ops` folder, pick **Create docker-compose.yml**, and paste this:

   ```yaml
   services:
     media-ops:
       image: ghcr.io/kaiserhomelab/media-ops:latest
       container_name: media-ops
       restart: unless-stopped
       environment:
         - PUID=1026
         - PGID=100
         - TZ=America/Chicago
         - HOST_NAME=synology
       ports:
         - "8484:8484"
       volumes:
         - /volume1/docker/media-ops:/config
         - /var/run/docker.sock:/var/run/docker.sock:ro
         - /volume1:/volume1:ro
   ```

4. Click **Next**, then **Done**. Open `http://<your-synology-ip>:8484`.
5. Under **Settings → General → Disks to show**, enter `/volume1`.

If you use the Synology firewall, allow port 8484 under **Control Panel → Security → Firewall**.

## QNAP

In **Container Station → Applications → Create**, paste the Compose file from the Synology
section above with these changes: set the settings folder to something like
`/share/Container/media-ops`, the disk line to `/share/CACHEDEV1_DATA:/share/CACHEDEV1_DATA:ro`,
and `PUID`/`PGID` to your user's `id` (often `1000` and `100`). Then enter
`/share/CACHEDEV1_DATA` under Disks to show.

## Portainer, Proxmox and others

- **Portainer:** go to **Stacks → Add stack**, paste [`docker-compose.yml`](../docker-compose.yml),
  change the settings folder to a full path (like `/opt/media-ops`, since `./config` means
  nothing to Portainer), and deploy.
- **Proxmox:** run Docker in a VM or an LXC container, then follow the [Linux](#linux) steps
  inside it. To see your media disks' space, pass them through to that VM or container first.
- **Anything else** that runs Linux containers (CasaOS, Umbrel, OpenMediaVault, Dockge,
  Komodo...) works the same way: give it the Compose file and point `/config` at a folder.

Media Ops guesses which system it's on from the kernel, to show the right tips. If it guesses
wrong, set `HOST_OS` (for example `HOST_OS=Synology`).

---

## Reaching your apps

When you add an app in Settings, you type the address Media Ops should use to reach it. That
address is used **from inside the Media Ops container**, which changes what works:

| Where the app runs | Address to use | Example |
|---|---|---|
| On another device or a NAS | its network IP | `http://192.168.1.10:8989` |
| In Docker on the same machine | the machine's network IP | `http://192.168.1.10:8989` |
| Installed directly on the same Windows PC or Mac | `host.docker.internal` | `http://host.docker.internal:32400` |
| Installed directly on the same Linux machine | the machine's network IP | `http://192.168.1.10:8989` |
| In the same Docker network as Media Ops | the container's name | `http://sonarr:8989` |

`localhost` and `127.0.0.1` never work here: inside a container they mean the container itself.
The **Test** button tells you if that's the problem.

## Updating

Media Ops tells you on the dashboard when a new version is out. The
[changelog](../CHANGELOG.md) says what changed. If you'd rather choose when to update, use a
version tag instead of `latest`: `:1.15` gets fixes only, `:1.15.0` never changes.

- **Unraid:** Docker tab → **Check for updates** → **Apply update**.
- **TrueNAS:** Apps → media-ops → **Edit**, then **Save** without changing anything. That pulls
  the latest image.
- **Docker Compose** (Linux, Windows, Mac): in the folder with the Compose file, run
  `docker compose pull && docker compose up -d`.
- **Synology:** connect over SSH and run
  `cd /volume1/docker/media-ops && sudo docker compose pull && sudo docker compose up -d`.
- **docker run:** `docker pull ghcr.io/kaiserhomelab/media-ops:latest`, then remove the
  container and run the same `docker run` command again. Your settings are in the folder you
  mapped to `/config`, so nothing is lost.
- **Portainer:** Stacks → media-ops → **Update the stack** with **Re-pull image** on.
