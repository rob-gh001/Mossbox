# Mossbox

Mossbox is a lightweight personal capture app with four modules:

- Drop — file/image upload and retrieval
- Notes — notes + todos in one place
- Bookmarks — saved links
- Tools — small HTTP/ping/DNS utilities

## Stack

- Node.js
- Express
- SQLite (`better-sqlite3`)
- EJS templates
- Local file storage

## Local setup

```bash
npm install
cp .env.example .env
# edit .env with your values
npm start
```

Then open:

- `http://127.0.0.1:3000`

## Environment variables

- `PORT` — listen port (default `3000`)
- `APP_PASSWORD` — login password for the web UI
- `SESSION_SECRET` — session secret for login/session cookies
- `API_KEY` — API auth key for `/api/*`

## API auth

API requests use either:

- `Authorization: Bearer <API_KEY>`
- `X-API-Key: <API_KEY>`

Web UI requests still use normal login/session auth.

## File API

- `GET /api/files` — list file metadata
- `GET /api/files/:id` — get one file metadata record
- `GET /api/files/:id/content` — stream raw file content
- `POST /api/files/upload` — upload a file with multipart form data; returns `contentUrl` and `webDownloadUrl`

## Notes API

- `POST /api/notes`
- `GET /api/notes`

## Bookmarks API

- `POST /api/bookmarks`
- `GET /api/bookmarks`

## Run on Rustix

1. Pull the repo into the Rustix container/server.
2. Install dependencies:

```bash
npm install
```

3. Create `.env`:

```bash
cp .env.example .env
```

4. Edit `.env` and set real values for:

- `APP_PASSWORD`
- `SESSION_SECRET`
- `API_KEY`

5. Start Mossbox:

```bash
npm start
```

## Important runtime notes

- Mossbox listens on `0.0.0.0`
- Port comes from `process.env.PORT || 3000`
- Uploaded files and SQLite DB live under `storage/`
- If possible, keep `storage/` persistent across restarts/redeploys

## Current scope

### Done
- file upload/download via web UI
- file upload/list/metadata/content via API
- notes + todos with filters and delete
- bookmarks with search and delete
- tools: HTTP fetch, ping validation, DNS lookup

### Still good future additions
- edit note/bookmark
- delete via API for files/notes/bookmarks
- better flash messages
- health endpoint
- nicer dashboard/home
- improved tools error reporting
