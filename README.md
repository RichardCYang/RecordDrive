# RecordDrive

RecordDrive is a self-hosted file workspace for small teams. It combines account-based access control, shared repositories, and a familiar file-explorer interface in a single Node.js application.

The project is deliberately simple to deploy: metadata, sessions, and activity history live in SQLite, while uploaded files stay on the local filesystem. No separate database server or cloud storage account is required.

## Highlights

- Session-based sign-in with administrator and member roles
- Repository creation, deletion, and participant management
- Multiple file uploads with configurable size and count limits
- Search, sorting, file-type filters, list view, and icon view
- Direct download and permission-aware deletion
- SQLite-backed metadata, sessions, and activity logs
- Password hashing with bcrypt, CSRF protection, Helmet headers, and sign-in rate limiting
- Responsive English-language, sky-blue interface designed around common desktop file-browser patterns
- Docker Compose setup with persistent storage
- End-to-end smoke test covering the main administration and file workflow

## Technology

- [Node.js](https://nodejs.org/) with ES modules
- [Express](https://expressjs.com/) and EJS
- SQLite through Node's built-in `node:sqlite` module
- Multer for multipart uploads
- `express-session` with a custom SQLite session store
- bcryptjs and Helmet
- Node's built-in test runner with Supertest

## Requirements

Choose either of the following setups:

- Node.js **22.16.0 or newer** and npm
- Docker with Docker Compose

The minimum Node.js version is enforced in `package.json`.

## Getting started

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000` in a browser.

On the first run, the application creates an administrator from the values in `.env`:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe123!
```

Change the password and `SESSION_SECRET` before exposing the service to other users. The administrator is only bootstrapped when no admin account exists, so editing `ADMIN_PASSWORD` later does not update an account that has already been created.

## Available commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the web server |
| `npm run dev` | Run with Node's watch mode |
| `npm test` | Execute the integration smoke test |
| `npm run check` | Check the server entry file for syntax errors |

## Configuration

All settings are read from environment variables. Copy `.env.example` and adjust the values for your environment.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port used by the application |
| `NODE_ENV` | `development` | Enables production cookie and proxy settings when set to `production` |
| `SESSION_SECRET` | Example value | Secret used to sign session cookies; use a long random value in production |
| `ADMIN_USERNAME` | `admin` | Username for the first administrator |
| `ADMIN_PASSWORD` | `ChangeMe123!` | Password for the first administrator |
| `ADMIN_DISPLAY_NAME` | `System Administrator` | Display name assigned to the first administrator |
| `MAX_FILE_SIZE_MB` | `100` | Maximum size of one uploaded file, in megabytes |
| `MAX_FILES_PER_UPLOAD` | `10` | Maximum number of files accepted in one request |
| `DB_PATH` | `./data/recorddrive.db` | SQLite database location |
| `UPLOAD_ROOT` | `./data/uploads` | Directory used for uploaded file contents |

Production mode refuses to start with the sample administrator password or an unsafe session secret.

## Roles and access

### Administrator

Administrators can:

- Open every repository
- Create and remove repositories
- Create and delete member accounts
- Add or remove participants for each repository
- Upload, download, and delete files anywhere
- Review recent activity from the administration dashboard

### Member

Members can:

- See repositories they have been assigned to
- Upload, download, and delete files in those repositories
- Use the file search, filters, sorting controls, and view modes

Administrative pages remain unavailable to regular accounts.

## File explorer

Each repository opens in a browser-style workspace with a breadcrumb bar, search field, command toolbar, category filters, and optional details panel. A file can be selected with one click or downloaded from its name. The interface also supports:

- Newest, oldest, alphabetical, and size-based sorting
- List and icon layouts saved in the browser
- File-type filtering for documents, images, media, archives, and other content
- `Ctrl+F` or `Command+F` to focus repository search
- `Esc` to clear a selection or close the upload panel

Repositories currently use a flat file list. Nested folders are not part of this release.

## Docker

Create the environment file first, then set `NODE_ENV=production` and replace the sample secrets.

```bash
cp .env.example .env
docker compose up --build -d
```

The Compose configuration stores the database and uploaded files in the `recorddrive_data` volume. Stop and remove the container without deleting that volume when upgrading.

To inspect the service health:

```bash
curl http://localhost:3000/health
```

A healthy instance responds with:

```json
{
  "status": "ok",
  "service": "RecordDrive"
}
```

## Data and backups

By default, all persistent content is kept under `data/`:

- `recorddrive.db` contains accounts, repositories, memberships, file metadata, sessions, and activity records.
- `uploads/` contains the actual file contents, grouped by repository ID.

Back up the database and upload directory together. For a straightforward offline backup, stop the application first and copy the entire `data` directory. The runtime directory is excluded from Git so private files, sessions, and local database contents are not committed accidentally.

## Project layout

```text
RecordDrive/
├── src/
│   ├── app.js                 # Express setup and application entry point
│   ├── config.js              # Environment configuration
│   ├── database.js            # Schema creation and administrator bootstrap
│   ├── session-store.js       # SQLite-backed session store
│   ├── middleware/            # Authentication, CSRF, and login throttling
│   └── routes/                # Authentication, dashboard, admin, and file routes
├── views/                     # EJS templates
├── public/                    # Stylesheets and browser-side JavaScript
├── data/                      # Local runtime data; ignored by Git
├── test/                      # Integration smoke test
├── Dockerfile
└── docker-compose.yml
```

## Deployment notes

Run the service behind an HTTPS reverse proxy and set `NODE_ENV=production`. Keep `SESSION_SECRET` outside source control, use a unique administrator password, and protect the `data` volume with regular backups and suitable filesystem permissions.

This build is intended for a single application instance using local SQLite and disk storage. A multi-instance deployment would need shared sessions, a networked database, and object storage. Malware scanning, file previews, version history, public links, trash recovery, quotas, and nested directories are also outside the current scope.
