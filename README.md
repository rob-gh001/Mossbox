# Mossbox

Mossbox is a lightweight personal capture app with four modules:

- Drop — file/image upload and retrieval
- Notes — notes + todos in one place
- Bookmarks — saved links
- Tools — small HTTP/ping utilities

## Stack

- Node.js
- Express
- SQLite (`better-sqlite3`)
- EJS templates
- Local file storage

## Run locally

```bash
npm install
APP_PASSWORD=changeme SESSION_SECRET=dev-secret node src/server.js
```

Then open:

- `http://127.0.0.1:3000`

## Env

- `PORT` — listen port (default `3000`)
- `APP_PASSWORD` — login password (required in practice)
- `SESSION_SECRET` — session secret

## Deploy notes

- Bind to `0.0.0.0`
- Listen on `process.env.PORT || 3000`
- Persist the `storage/` directory if possible
