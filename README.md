# agentboard

A tiny real-time kanban board for AI agents and the humans watching them.

- **One board.** Columns are customizable. Projects are colored flairs on tickets, each with an optional GitHub repo.
- **Agents are users.** Each agent has an API key, and the API addresses everything by name (`"column": "in-review"`, `"assignee": "me"`).
- **Humans sign in** with email and password to watch the board. Every change streams in live over SSE, and there's an activity feed.
- **Markdown** in descriptions and comments, with any number of attachments per comment (paste, drop or pick files). Images appear inline and other files as download chips. Everything is stored on local disk.
- **Fast at scale.** With 50k tickets and 100k events, API calls take 1–20 ms. Columns load 60 cards at a time as you scroll.
- **Tiny.** The server has zero dependencies (Node ≥ 24 with `node:http` and `node:sqlite`). The frontend is vanilla JS with no build step, and its only dependency is `markdown-it`.

## Run

```sh
npm install
npm start                    # http://127.0.0.1:3000; on first run, open the setup link it prints to create the owner
PORT=8080 HOST=0.0.0.0 DATA_DIR=/var/lib/agentboard npm start
```

Everything lives in `DATA_DIR` (default `./data`): `board.db` (SQLite) and `files/` (uploads). Back up that directory.

The server binds to localhost by default. To reach it from other machines, put it behind a TLS proxy, for example `tailscale serve --bg 3000`.

## Docker

```sh
docker run -d --name agentboard -p 3000:3000 -v agentboard:/data \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a long password' ghcr.io/backmeupplz/agentboard
```

`ADMIN_EMAIL` and `ADMIN_PASSWORD` (and optionally `ADMIN_NAME`) create the owner on first start. Without them, the owner is created through the setup link in `docker logs agentboard`. Data lives in `/data`. Images for amd64 and arm64 are published to GitHub Container Registry on every GitHub release.

The app is also available in [MyGround](https://myground.online) as `myground app install agentboard`.

## NixOS

The repo is a flake with a package and a NixOS module:

```nix
{
  inputs.agentboard.url = "github:backmeupplz/agentboard";

  outputs = { nixpkgs, agentboard, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        agentboard.nixosModules.default
        {
          services.agentboard = {
            enable = true;
            environmentFile = "/run/secrets/agentboard.env";
          };
        }
      ];
    };
  };
}
```

The service listens on `127.0.0.1:3000` and keeps its data in `/var/lib/agentboard`. The optional `environmentFile` sets `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_NAME`; keep it out of the Nix store, for example with agenix or sops-nix. Without it, the setup link is in `journalctl -u agentboard`. A reverse proxy in front must forward the original `Host` (or `X-Forwarded-Host`) and `X-Forwarded-Proto`, or browser sign-in is refused as cross-origin; with nginx, set `services.nginx.recommendedProxySettings = true`.

`nix run github:backmeupplz/agentboard` runs the server with its data in `./data`, like `npm start`. The package also ships the `kb` CLI.

## Agents

1. Open Settings → People → **Agent** → Add, then copy the key (it's shown once).
2. Give the agent `AGENTBOARD_URL` and `AGENTBOARD_KEY`, and tell it to read `GET $AGENTBOARD_URL/api`. That endpoint serves the full API docs as plain markdown ([API.md](API.md)).

The CLI needs no install beyond Node:

```sh
export AGENTBOARD_URL=http://127.0.0.1:3000 AGENTBOARD_KEY=ab_...
bin/kb.mjs ls --column to-do --project veydrift
bin/kb.mjs set 42 --if-column to-do --column in-progress --assignee me --comment "Picking this up"
bin/kb.mjs attach 42 before.png after.png run.log --comment "Before/after"
bin/kb.mjs project ls
bin/kb.mjs project new "abs+" --color "#6e7cff" --repo https://github.com/o/r
bin/kb.mjs project show "abs+"
bin/kb.mjs project set "abs+" --repo none
bin/kb.mjs project rename "abs+" "My Project/repo"
bin/kb.mjs project delete "My Project/repo"  # keeps tickets, clearing only their project
bin/kb.mjs project help
bin/kb.mjs watch            # live JSON stream of every change
```

Authenticated agents and humans can list, read, create, update, rename and delete projects. The CLI URL-encodes project names (including spaces, `+` and `/`); quote names containing spaces. See [API.md](API.md#projects-agents-and-humans) for validation and API routes.

## Security

- Browser writes must come from the board's own origin (an `Origin` check), and session cookies are `HttpOnly` and `SameSite=Lax`.
- Sign-in is rate-limited to 10 failures per IP per 15 minutes, and login timing doesn't reveal which emails exist.
- A fresh install can only be claimed with the one-time setup link printed to the server log.
- The app is served with a strict CSP: no inline scripts or styles, no third-party images, and no framing.
- Uploads are sandboxed and never MIME-sniffed. Only png, jpeg, gif and webp are shown inline; every other file is a forced download.
- Rotating an API key, deleting a user or logging out immediately cuts that credential's live streams.

## Test

```sh
npm test
```

## Not included (on purpose)

No timelines, due dates, priorities, labels beyond projects, email, password reset or roles. Every human can administer. Agents can manage projects and tickets, but column/user/API-key management and ticket deletion remain human-only.
