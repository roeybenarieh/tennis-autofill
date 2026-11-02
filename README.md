# tennis-autofill

Watches a WhatsApp group for a Google Form link, fills the form (personal details hardcoded, other answers via an LLM), and submits it. Pure Node.js.

**Warning:** running it listens to a live chat and submits real forms. Only run it when you want the form sent. Use `LINKS_ONLY=1` or `DRY_RUN=1` to test.

## Installing as a systemd service: order of actions

Do these in order. Steps 1 to 5 are one-time manual setup; the service must not run until they are done (two processes on one WhatsApp login kick each other out). Details for each step are in the sections below.

1. **Log in to Google in Chromium** as the user the service will run as. Form reading and submitting reuse that profile's cookies.
2. **Create the env file** `~/.config/tennis-autofiller/env` (that user's home, `chmod 600`) with `OPENROUTER_API_KEY=...`. You cannot set `WATCH_CHAT_ID` yet; you get it in step 4.
3. **Create the state directory**, owned by that user: `sudo mkdir -p /var/lib/tennis-autofill && sudo chown <user> /var/lib/tennis-autofill`. It will hold the WhatsApp login (`auth/`) and the link cache.
4. **Pair WhatsApp and find the group ID**, as that user, using the same state directory the service will use:
   `STATE_DIR=/var/lib/tennis-autofill nix run github:roeybenarieh/tennis-autofill -- --list-groups`
   Open the QR page it prints (`~/whatsapp-qr.html`), scan it under WhatsApp > Linked devices > Link a device, then copy the `id` of your group from the printed list into the env file as `WATCH_CHAT_ID=<id>@g.us`.
5. **Test without submitting**, still with the same `STATE_DIR`: first `LINKS_ONLY=1`, then `DRY_RUN=1` (see [Running](#running)). Use a group only you are in and a disposable form. Stop the test (Ctrl+C) before step 7.
6. **Add the flake and define the service** in your NixOS configuration, using the example under [Running as a service](#running-as-a-service). Set `User` to the same user, and `STATE_DIR` to the directory from step 3.
7. **Rebuild and start**: `sudo nixos-rebuild switch --flake .#<hostname>`. The unit starts on boot (`wantedBy = multi-user.target`). From now on it **submits forms**.
8. **Verify**: `systemctl status tennis-autofill` and `journalctl -u tennis-autofill -f` should show `Connected; watching <group>`. Stop it any time with `systemctl stop tennis-autofill`.

If the service logs `Disconnected (401)` or exits after being logged out or replaced, delete `<STATE_DIR>/auth` and repeat step 4.

## How it works

1. [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp Web client, linked as a device) receives messages from `WATCH_CHAT_ID`, including your own. [baileys-keep-alive](https://github.com/kobie3717/baileys-keep-alive) owns reconnecting; [baileys-antiban](https://github.com/kobie3717/baileys-antiban) supplies reconnect delay advice (Baileys' own codes win where they disagree).
2. A Google Form link (`https://docs.google.com/forms/...`, not `forms.gle`) in a *new* message triggers the workflow. Links sent before startup are cached (40-hour window, live and history-sync messages, deduplicated) but not submitted. Each distinct URL is handled once per run.
3. The form is read with your Chromium login cookies, answers are generated (name, email, phone and time slot are hardcoded in `forms.js`; anything else goes to OpenRouter in Hebrew, one short clause), and the form is submitted. A submission counts only if Google's confirmation message appears.
4. If reading, answering or submitting fails, it notifies you, opens the form in your browser (`xdg-open`) and keeps watching. An unconfirmed submission is never retried automatically: check whether Google recorded it first.

**Risks.** Baileys reverse-engineers WhatsApp Web; WhatsApp's Terms of Service do not allow it, and the number can be restricted or banned (the whole number, including the phone app). Prefer a secondary number. The watcher is passive: it sends no messages, typing indicators or read receipts. The only thing Baileys itself sends beyond the protocol handshake and keepalives is a single "unavailable" presence update on each connect (the account is not shown as online). `baileys-antiban` cannot guarantee against bans. WhatsApp controls initial history delivery, so a full 40-hour backfill is not guaranteed; keep it running for continuous coverage.

## Requirements

- Node.js 22.13+ (uses built-in `node:sqlite`) and npm
- Chromium, logged in to the Google account used for the form. Cookies are read from `~/.config/chromium/Default/Cookies` (override with `CHROMIUM_PROFILE`). Only Chromium's `v10` cookie encryption is supported (used when no system keyring is in play); `v11` cookies stop the run with a clear error.
- `notify-send` (libnotify) and `xdg-open` for notifications and the browser fallback (best effort; the Nix build bundles them)

## Setup

```sh
npm ci
node index.js --list-groups     # pairs on first run, prints {"id","name","participants"} per group
```

Pairing: the first run writes a QR code page to `~/whatsapp-qr.html` (override with `QR_HTML_PATH`) and prints its path. Open it in a browser and scan it under WhatsApp > Linked devices > Link a device. The file is private (mode 600), refreshes itself, and is deleted once linked. Put the group's ID in the env file (below).

## Configuration

Read from `${XDG_CONFIG_HOME:-~/.config}/tennis-autofiller/env` (`KEY=VALUE` lines, `#` comments). Real environment variables win. Keep it private (`chmod 600`).

| Variable | Meaning |
|---|---|
| `WATCH_CHAT_ID` | **Required.** Group JID (`...@g.us`) to watch. No default. |
| `OPENROUTER_API_KEY` | Required unless `LINKS_ONLY=1`. |
| `LINKS_ONLY=1` | Only log detected links; no Google, no LLM. |
| `DRY_RUN=1` | Read the form and generate answers, never submit. |
| `STATE_DIR` | WhatsApp session (`auth/`) and link cache (`forms.json`). Default `${XDG_STATE_HOME:-~/.local/state}/tennis-autofill`. Keep private: `auth/` is the login. |
| `QR_HTML_PATH` | Where the pairing QR page is written. Default `~/whatsapp-qr.html`. |
| `CHROMIUM_PROFILE` | Chromium profile directory holding `Cookies`. Default `~/.config/chromium/Default`. |

Answers live in `forms.js` (`answerQuestions`): the time-slot option must match one of the form's choices exactly. `aiAnswer` writes each reply to `hello.txt` in the working directory (debug side effect, kept on purpose).

## Running

```sh
LINKS_ONLY=1 node index.js      # 1. check WhatsApp detection (send a link to the group)
DRY_RUN=1 node index.js         # 2. also read the form and generate answers
node index.js                   # 3. the real thing: submits forms
node index.js --history         # print cached links for WATCH_CHAT_ID (no connection)
```

For tests use a group only you are in, and a disposable form. Ctrl+C stops it. Run only one instance per `STATE_DIR`. A fatal disconnect (logged out, replaced by another device) exits with status 1 and a notification; re-pair by deleting `STATE_DIR/auth` and running again.

Offline tests (no WhatsApp, Google or LLM access): `npm test`.

## Nix

The flake exports only the package (`packages.<system>.default`, for x86_64-linux and aarch64-linux). It bundles Node.js, `notify-send` and `xdg-open`.

```sh
nix run github:roeybenarieh/tennis-autofill   # or, in a clone: nix run .#default  (just run-nix)
nix build .#default                    # just build
```

After changing `package-lock.json`, update `npmDepsHash` in `flake.nix` (set `pkgs.lib.fakeHash`, run `nix build`, copy the hash from the error). Flakes only see Git-tracked files: `git add` new files first.

### Running as a service

Bring your own unit: the flake provides the package, you define the service. A NixOS example (`user` supplies the Chromium profile with the Google login; `HOME` is set by systemd from it, so the env file at `~/.config/tennis-autofiller/env` is found automatically):

```nix
{
  inputs.tennis-autofill.url = "github:roeybenarieh/tennis-autofill"; # or "path:/path/to/clone"
  inputs.tennis-autofill.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, tennis-autofill, ... }: {
    nixosConfigurations.<hostname> = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ({ pkgs, ... }: {
          systemd.services.tennis-autofill = {
            description = "tennis-autofill";
            wantedBy = [ "multi-user.target" ];
            wants = [ "network-online.target" ];
            after = [ "network-online.target" ];
            environment.STATE_DIR = "/var/lib/tennis-autofill"; # WhatsApp login + link cache
            script = ''
              # desktop notifications go to the user's session bus
              export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(${pkgs.coreutils}/bin/id -u)/bus"
              exec ${tennis-autofill.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/tennis-autofill
            '';
            serviceConfig = {
              User = "roey";
              StateDirectory = "tennis-autofill";
              WorkingDirectory = "/var/lib/tennis-autofill"; # hello.txt is written to the cwd
              Restart = "on-failure";
              RestartSec = 60;
            };
          };
        })
      ];
    };
  };
}
```

Notes:
- **Pair first, interactively, as the same user**, into the service's state directory, then start the service: `sudo mkdir -p /var/lib/tennis-autofill && sudo chown roey /var/lib/tennis-autofill`, then `STATE_DIR=/var/lib/tennis-autofill nix run .#default -- --list-groups`. (If the service already ran, `StateDirectory` created and owns it.)
- The service runs unattended and **submits forms**. Stop it with `systemctl stop tennis-autofill` if you do not want that.
- Logs go to the journal (`journalctl -u tennis-autofill -f`). To keep them out of it, add `StandardOutput = "append:/var/lib/tennis-autofill/tennis-autofill.log";` and rotate the file with `services.logrotate.settings`.
- Without NixOS, a systemd user unit works too: `ExecStart=/usr/bin/env nix run /path/to/clone#default`, `Restart=on-failure`, `RestartSec=60`, `WantedBy=default.target`.

## Migrating from the Python version

The Python script and the Green API backend are gone. `GREEN_API_*` entries in the env file are unused and can be deleted. An existing WhatsApp pairing from the old `baileys-watcher/state` directory can be moved to the new `STATE_DIR` as is.
