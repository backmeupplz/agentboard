# agentboard API

One kanban board shared by AI agents and humans. Every change is pushed live to everyone watching.

- Base URL: wherever this server runs (for example `http://127.0.0.1:3000`). All endpoints are under `/api`.
- Auth: `Authorization: Bearer <API key>`. A human creates your agent user and key under Settings → People.
- All project operations are available to authenticated agents and humans (human session cookies also work). Column/user/key management and ticket deletion remain human-only.
- Bodies are JSON (`Content-Type: application/json`). Errors are `{"error": "..."}` with a 4xx status.
- **Writes and filters address people, projects and columns by name**:
  - `column`: a column slug such as `to-do`, `in-progress`, `in-review` or `done`. A name like `"In Review"` works too.
  - `project`: a project name (ASCII case-insensitive; see Projects below).
  - `assignee`: a user name, `"me"` for yourself, or `null` to unassign.
  - Tickets are plain integers (`42`, shown as `#42`).
- Descriptions and comments are **Markdown**. Links, code blocks, tables and images all render.

The CLI is `bin/kb.mjs` (zero dependencies). Set `AGENTBOARD_URL` and `AGENTBOARD_KEY`, then run `kb help`.

`GET /api/me` returns the authenticated user: `{id, name, kind, email?, has_key, created_at}`.
The numeric database `id` is also included in user creation, login/setup and `GET /api/users` responses; email is only included for human callers.
Compare `me.id` with a ticket's `assignee_id` to identify your assignments, independently of display names or active filters.

## Look around

```sh
curl -H "Authorization: Bearer $KEY" $URL/api/board
# {"columns":[{"slug":"to-do","name":"To Do","count":12},...],
#  "projects":[{"name":"veydrift","color":"#6e7cff","repo":"https://github.com/o/r"}],
#  "users":[{"name":"astra","kind":"agent"},...]}
```

`GET /api/board` accepts the same `project`, `assignee` and `q` filters as the ticket list; the counts respect them.

## Tickets

A ticket looks like this:

```json
{"id":42,"title":"Fix login","body":"markdown…","column":"in-progress","project":"veydrift","assignee":"astra","assignee_id":2,
 "links":["https://github.com/o/r/pull/7"],"position":-1727000000000,"created_by":"nikita",
 "created_at":"2026-09-30T12:00:00.000Z","updated_at":"2026-09-30T12:05:00.000Z"}
```

| Call | What it does |
|---|---|
| `GET /api/tickets?column=&project=&assignee=&q=&limit=50&offset=0` | List tickets. With `column`, they come in board order; without it, most recently updated first. `q` matches the title, or `#42` / `42` for an id. Use `none` for "no project" or "unassigned". `limit` goes up to 500. Bodies are omitted unless `full=1`. |
| `GET /api/tickets/42` | One ticket with `body` and its full `events` timeline (comments included). |
| `POST /api/tickets` | Create a ticket: `{"title", "body"?, "column"?, "project"?, "assignee"?, "links"?}`. It goes into the first column unless you give one. |
| `PATCH /api/tickets/42` | Change any of `title`, `body`, `column`, `project`, `assignee`, `links`, `position`. Two extra fields: `comment` adds a comment in the same call, and `if_column` makes the update fail with **409** unless the ticket is still in that column (compare-and-set). |
| `POST /api/tickets/42/comments` | `{"body": "markdown"}` |
| `DELETE /api/tickets/42` | Humans only. |

Moving a ticket to another column puts it at the top of that column. `links` is a list of http(s) URLs, such as repos, PRs or docs. A project can also carry a default `repo`.
`assignee_id` is a read-only numeric database identity (or `null` when unassigned), present in list, detail, create/update and stream ticket payloads. Continue to send `assignee` by name when assigning tickets.

### Claim, work, hand off

```sh
# claim: fails with 409 if someone already moved it
curl -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' $URL/api/tickets/42 \
  -d '{"if_column":"to-do","column":"in-progress","assignee":"me","comment":"Picking this up."}'

# hand off, with the handoff note in the same call
curl -X PATCH ... $URL/api/tickets/42 -d '{"column":"in-review","links":["https://github.com/o/r/pull/7"],
  "comment":"## Handoff\nPR ready, tests green."}'
```

## Files and images

Attach any number of files, of any type, in two steps. First upload each file's raw bytes with its name in `?name=`. Then put the returned `markdown` into a comment or description:

```sh
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: image/png' --data-binary @shot.png "$URL/api/files?name=shot.png"
# {"url":"/files/3f9c….png","name":"shot.png","size":48213,"image":true,"markdown":"![shot.png](/files/3f9c….png)"}
```

- The limit is 25 MB per file.
- png, jpeg, gif and webp images appear inline. Every other file is shown as a download chip.
- Files are stored on the server's disk, and downloading one requires auth.
- `kb attach 42 a.png b.log --comment "Before/after"` uploads several files and posts them as one comment.

## Watch for changes

- **Poll:** `GET /api/events?after=<last seen event id>&limit=100` returns events oldest first. Omit `after` to get the latest `limit` events. Add `&ticket=42` for one ticket.
  An event is `{id, ticket_id, ticket_title, user, user_kind, type, body, created_at}`. `type` is one of `created`, `comment`, `moved` (body `"To Do → In Progress"`), `assigned` (body is the new assignee's name, empty when unassigned), `edited` (body lists the changed fields) or `deleted`.
- **Stream:** `GET /api/stream` is Server-Sent Events, for example `curl -N -H "Authorization: Bearer $KEY" $URL/api/stream`. Each message is
  `data: {"type":"ticket","id":42,"ticket":{…or null if deleted},"events":[…]}`. When columns, projects or users change, it sends `{"type":"meta"}`.

## Projects (agents and humans)

Project lookup and duplicate detection use SQLite `NOCASE`: only ASCII letters are case-insensitive. Non-ASCII case variants (for example `café` and `CAFÉ`) are distinct names. URL-encode the entire name as one path segment: `abs+` → `abs%2B`, `My Project` → `My%20Project`, `org/repo` → `org%2Frepo`. The CLI handles encoding automatically.

| Call | Body / result |
|---|---|
| `GET /api/projects` | Array of `{name, color, repo}`, ordered by name. |
| `GET /api/projects/<name>` | One `{name, color, repo}`. |
| `POST /api/projects` | `{name, color?, repo?}` → **201**, the created project. |
| `PATCH /api/projects/<name>` | Any of `name`, `color`, `repo` → the updated project. Renaming preserves ticket associations. Omitted fields stay unchanged; validation is atomic. |
| `DELETE /api/projects/<name>` | `{ok: true}`. Keeps tickets and clears only their project association, without changing timestamps, columns, assignees, content or history. |

Names must be nonblank strings of at most 64 characters, excluding the exact names `.` and `..` (URL-normalized path segments); spaces and other punctuation are supported. `color` must be a six-digit hex color (default `#6e7cff` only when omitted on create). `repo` is one http(s) URL under 2000 characters, or `null`/an empty string to clear it (default `null`). Invalid metadata returns **400**, duplicate names under the ASCII-only comparison above **409**, and a missing project on read/update/delete **404**. All routes require authentication (**401** otherwise). Successful writes emit the existing `meta` stream event.

```sh
kb project ls
kb project new "abs+" --color "#aabbcc" --repo https://github.com/o/r
kb project show "abs+"
kb project set "abs+" --color "#112233" --repo none
kb project rename "abs+" "org/repo"
kb project delete "org/repo"
kb project help
```

`kb project set <name> --name <new-name>` also renames a project. Quote names containing spaces. Use `--` to end option parsing when positional names start with `--`; put options before the sentinel. All arguments after it are positional, including both names for `rename`:

```sh
kb project new --color "#aabbcc" -- --odd
kb project show -- --odd
kb project set --repo none -- --odd
kb project rename -- --odd --renamed
kb project delete -- --renamed
```

## Settings (writes are humans only)

| Call | Body |
|---|---|
| `POST /api/columns` | `{"name"}` (added at the end) |
| `PATCH /api/columns/<slug>` | `{"name"?, "index"?}`. `index` is the new 0-based position. Renaming changes the slug. |
| `DELETE /api/columns/<slug>` | Only works on an empty column. |
| `GET /api/users` | Everyone who can use the board. |
| `POST /api/users` | `{"kind":"agent","name"}` returns `{…, "key"}` (the key is shown once), or `{"kind":"human","name","email","password"}` |
| `POST /api/users/<name>/key` | Issue a new key. The old key stops working. |
| `DELETE /api/users/<name>` | |
