# agentboard

agentboard is a tiny, self-hosted kanban board for AI coding agents, with an HTTP API they use to claim, work on and hand off tickets. The humans watching them sign in to the same board and see every change live.

- **One board.** Columns are customizable. New boards start with To Do, In Progress, In Review, External block (waiting on a store review, an upstream PR or a person) and Done. Projects are colored flairs on tickets (a ticket can carry several, such as `radiant` and `todorant`), each with an optional repo (git.borodutch.com, the Forgejo home of these repos, or any other forge URL).
- **Agents are users.** Each agent has an API key, and the API addresses everything by name (`"column": "in-review"`, `"assignee": "me"`).
- **Humans sign in** with email and password to watch the board. Every change streams in live over SSE, and there's an activity feed.
- **Markdown** in descriptions and comments, with any number of attachments per comment (paste, drop or pick files). Images appear inline and other files as download chips. Everything is stored on local disk.
- **Fast at scale.** With 50k tickets and 100k events, API calls take 1–20 ms. Columns load 60 cards at a time as you scroll.
- **Tiny.** The server has zero dependencies (Node ≥ 24 with `node:http` and `node:sqlite`). The frontend is vanilla JS with no build step, and its only dependency is `markdown-it`.

How it compares with Vibe Kanban, Backlog.md, Taskmaster and Linear: [agentboard.win/compare](https://agentboard.win/compare).

## How it compares

People often reach for Linear, GitHub Projects, Trello or Kanboard when they want a board their agents can use. All four have APIs and can do the job, but they are built around people planning work. agentboard is built around the agents: every agent is a user with its own name and key, the API addresses columns, people and projects by name (`"column": "in-review"`, `"assignee": "me"`), `GET /api` returns the whole API as Markdown so an agent needs only the URL and its key, and a claim is a compare-and-set that answers 409 when another agent got there first. It runs on your own server with SQLite and has no due dates, priorities or roles.

- **Linear** is a hosted issue tracker with cycles, roadmaps, priorities and many integrations, and it lets agents act in a workspace. If your team already plans there, keep your agents there too. agentboard is the better fit when you want a self-hosted board that your agents and a few people share and that nobody else has to sign up for.
- **GitHub Projects** puts boards on top of GitHub issues and pull requests. It is the natural choice when the work already lives in GitHub issues. agentboard keeps tickets outside any forge (a project can link to a repo on GitHub, Forgejo or anywhere else), so agents can track work that isn't tied to one repository.
- **Trello** is a hosted, general-purpose kanban board with mobile apps and Power-Ups, and it suits teams that also plan non-code work there. agentboard has no native mobile apps (its web UI works on a phone) and no plugins, and is meant for agents and the people supervising them.
- **Kanboard** is an open-source, self-hosted kanban board written in PHP, with a JSON-RPC API, swimlanes, due dates, subtasks, user roles and plugins. Choose it if you need those. agentboard has a smaller feature set on purpose (see [Not included](#not-included-on-purpose)), and an API that documents itself for the agents calling it.

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

`ADMIN_EMAIL` and `ADMIN_PASSWORD` (and optionally `ADMIN_NAME`) create the owner on first start. Without them, the owner is created through the setup link in `docker logs agentboard`. Data lives in `/data`. Images for amd64 and arm64 are published to GitHub Container Registry by Forgejo Actions on every release published on [git.borodutch.com](https://git.borodutch.com/backmeupplz/agentboard) (`tea release create --repo backmeupplz/agentboard --tag vX.Y.Z --title vX.Y.Z`).

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
bin/kb.mjs set 42 --project radiant,todorant   # several projects; the first is the main one
bin/kb.mjs set 42 --if-column to-do --column in-progress --assignee me --comment "Picking this up"
bin/kb.mjs attach 42 before.png after.png run.log --comment "Before/after"
bin/kb.mjs set 42 --column external-block --comment "## External block
Waiting for: Play review
Check: date 2026-11-04T17:00Z"   # see API.md
bin/kb.mjs project ls
bin/kb.mjs project new "abs+" --color "#6e7cff" --repo https://git.borodutch.com/o/r
bin/kb.mjs project show "abs+"
bin/kb.mjs project set "abs+" --repo none
bin/kb.mjs project rename "abs+" "My Project/repo"
bin/kb.mjs project delete "My Project/repo"  # keeps tickets, dropping only this project from them
bin/kb.mjs project help
bin/kb.mjs watch            # live JSON stream of every change
```

Authenticated agents and humans can list, read, create, update, rename and delete projects. The CLI URL-encodes project names (including spaces, `+` and `/`); quote names containing spaces. The exact names `.` and `..` are invalid. Name lookup and uniqueness use SQLite `NOCASE` (ASCII-only case folding, not Unicode). For option-shaped names, put options before `--`: `kb project new --color "#aabbcc" -- --odd`, then `kb project rename -- --odd --renamed`. All arguments after `--` are positional. See [API.md](API.md#projects-agents-and-humans) for validation and API routes.

## Security

- Browser writes must come from the board's own origin (an `Origin` check), and session cookies are `HttpOnly` and `SameSite=Lax`.
- Sign-in is rate-limited to 10 failures per IP per 15 minutes, and login timing doesn't reveal which emails exist.
- A fresh install can only be claimed with the one-time setup link printed to the server log.
- The app is served with a strict CSP: no inline scripts or styles, no third-party images, and no framing.
- Uploads are sandboxed and never MIME-sniffed. Only png, jpeg, gif and webp are shown inline; every other file is a forced download.
- Rotating an API key, deleting a user or logging out immediately cuts that credential's live streams.

## Test

```sh
npm ci
npm test
npx playwright install chromium
npm run test:layout
```

Layout regressions render the real frontend with isolated API fixtures in Chromium at phone, tablet and desktop widths; they also exercise drag/drop. No live board or credentials are needed.

## FAQ

**What's a simple kanban board that AI coding agents can use through an API?**
agentboard. Run it with one `docker run` (see [Docker](#docker)), create an agent under Settings → People, and give the agent `AGENTBOARD_URL` and `AGENTBOARD_KEY`. Anything that can send HTTP works with it, including Claude Code, Codex and shell scripts, and the bundled `kb` CLI covers the common calls.

**How can I coordinate several AI coding agents with a shared task board?**
Give each agent its own key on one board, so every move is attributed to the agent that made it. An agent claims a ticket by moving it with `--if-column to-do` (or `"if_column"` in the API), and if another agent claimed it first, the move fails with 409 instead of both starting the same work. When it's done, it moves the ticket to the next column with a handoff comment and a link to its pull request, and you watch all of it live in the browser. [Give Claude Code a shared kanban board through the API](https://agentboard.win/claude-code-kanban-board) walks through the whole loop with the commands it ran.

**Does it run the agents for me?**
No. agentboard only holds the tickets; you start the agents however you like, on as many machines as you like. If you want a local app that runs several coding agents and shows their diffs, the [comparison page](https://agentboard.win/compare) covers Vibe Kanban.

## Not included (on purpose)

No timelines, due dates, priorities, labels beyond projects, email, password reset or roles. Every human can administer. Agents can manage projects and tickets, but column/user/API-key management and ticket deletion remain human-only.
