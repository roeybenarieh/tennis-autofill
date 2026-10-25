# tennis-autofill

Watches the tennis WhatsApp group for a Google Form link, fills the form (personal details hardcoded, other answers via an LLM), and submits it.

**Warning:** running the script polls the live chat and submits real forms. Only run it when you want the form sent.

## Requirements

- Chromium, logged in to the Google account used for the form (the script reuses its cookies)
- `uv` (manual run) or Nix with flakes (service run)
- A running desktop notification service; on Linux, `notify-send` (`libnotify`) and access to the desktop session bus. The Nix environment includes `libnotify`.

## Manual run

```sh
uv sync          # install dependencies
just run         # or: uv run main.py
```

The script continuously reads the Green API notification queue (`receiveNotification`, ~5.6 to 10 s per poll). For each Google Form link from the tennis group, it fills and submits the form, then resumes watching. Desktop notifications report discovery, confirmed submission, or failure without delaying submission.

If reading, answering, or submitting fails, it attempts to open the form in your browser (`xdg-open`) and continues watching. An unconfirmed submission is not retried automatically: check whether Google recorded it before submitting manually. Google reads/submissions have connection and read timeouts of 5 and 30 seconds. Polling errors wait 5 seconds before retrying and notify once per outage.

Offline tests (no live chat access or submissions):

```sh
uv run python -m unittest discover -v
```

## Nix

```sh
nix run .#default   # or: just run-nix
nix build .#default # or: just build
```

## Running as a service

The flake exports a NixOS service module (see below). Alternatively, the following systemd user unit runs the flake app. Adjust `WorkingDirectory` to your clone path.

`~/.config/systemd/user/tennis-autofill.service`:

```ini
[Unit]
Description=tennis-autofill

[Service]
WorkingDirectory=%h/Documents/coding/python/tennis-autofill
ExecStart=/usr/bin/env nix run .#default
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
```

Enable it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now tennis-autofill
```

The service runs unattended. Stop it with `systemctl --user stop tennis-autofill` if you do not want forms sent.

### Declarative (NixOS module)

The flake exports `nixosModules.default`. Add the flake as an input in your NixOS configuration and enable the service:

```nix
{
  inputs.tennis-autofill.url = "path:/home/roey/Documents/coding/python/tennis-autofill";

  outputs = { nixpkgs, tennis-autofill, ... }: {
    nixosConfigurations.<hostname> = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        tennis-autofill.nixosModules.default
        {
          services.tennis-autofill = {
            enable = true;
            user = "roey"; # its Chromium profile provides the Google login cookies
          };
        }
      ];
    };
  };
}
```

This runs the service as a system unit (`systemctl status tennis-autofill`). It stores its state in `/var/lib/tennis-autofill`. Notifications use the configured user's desktop session bus; they are available while that user's desktop notification service is running.

### Logs and log size

stdout is written to `/var/lib/tennis-autofill/tennis-autofill.log`, not the journal, so it doesn't grow the journal. Each poll writes one line (~10 s apart, about 0.3 MB/day). logrotate runs daily and keeps 7 compressed copies, so the log stays bounded at a few MB.

```sh
tail -f /var/lib/tennis-autofill/tennis-autofill.log   # follow logs
```

Errors still go to the journal: `journalctl -u tennis-autofill -f`.

## Configuration

Answers are set in `main.py`:

- `answer_questions()`: name, email, phone, and the time-slot option (`שעה 8:00 רמה 5+6+7`). The option must match one of the form's choices exactly.
- `TENNIS_CHAT_ID`: the WhatsApp group.
- Credentials are read from `${XDG_CONFIG_HOME:-~/.config}/tennis-autofiller/env` (`KEY=VALUE` lines): `GREEN_API_ID_INSTANCE`, `GREEN_API_TOKEN`, `OPENROUTER_API_KEY`. Real environment variables take precedence. Keep the file private (`chmod 600`).
- The NixOS module passes the same file to the service via `services.tennis-autofill.environmentFile` (default: the configured user's `~/.config/tennis-autofiller/env`; missing file is ignored).

## Green API limits

Checked against the Green API docs (plans and rate limiter pages). Re-check these if the script behaves differently, since the limits can change.

**Developer plan (free)**
- Only 3 chats (contacts or groups) can be interacted with, and notifications are received from only 3 chats. The tennis group and your own chat take 2 of them.
- Messages from any other chat trigger a `quotaExceeded` notification and are not delivered.
- Monthly caps: `getChatHistory` 300, `checkWhatsapp` 100, `getStatusInstance` 100, `getAvatar` 100, `readChat` 100. Methods not listed (including `receiveNotification` and `deleteNotification`) have no monthly cap.

**Per-second rate limits (per instance)**
- `receiveNotification`: 100 requests/s
- `deleteNotification`: 100 requests/s
- `getChatHistory`: 1 request/s
- `getSettings`, `setSettings`, `getStateInstance`, `getWaSettings`: 1 request/s each

Requests above the limit get HTTP 429.

The script uses `receiveNotification` (one call per poll) plus `deleteNotification` for each notification received, far below the per-second limits.
