# RecordDrive

RecordDrive is a self-hosted Node.js file workspace with personal repositories and per-user repository permissions. Regular users create and own repositories, owners decide which actions another user may perform, and administrators retain full access to every repository.

Metadata, sessions, permission grants, and activity history are stored in SQLite. Uploaded file contents are stored on the local filesystem.

## Access model

### Administrator

Administrators can:

- View every repository
- Upload and download files in every repository
- Delete files and repositories
- Manage repository permission grants
- Create and delete regular user accounts
- Review activity and storage metrics

Administrators cannot create repositories. Repository creation is reserved for regular users.

### Repository owner

A regular user becomes the owner of every repository they create. Owners automatically receive all repository permissions and can:

- View the repository and file metadata
- Upload and download files
- Delete files and the repository
- Grant, update, and revoke permissions for other regular users

Owner permissions are implicit and cannot be removed through a permission grant.

### Shared user

A repository owner or administrator can grant any combination of the following permissions:

| Permission | Effect |
| --- | --- |
| `View` | Open the repository and view file metadata |
| `Upload` | Add files through the upload endpoint |
| `Download` | Download stored file contents |
| `Delete` | Delete files and permanently delete the repository |

Permissions are checked independently on every server request. A user with no `View` permission cannot discover or open another user's repository through the dashboard or a direct repository URL. A permission such as `Download` or `Upload` can technically be granted without `View`, but that user will not see the repository in the dashboard.

## Security behavior

- Access is denied by default unless the requester is an administrator, the repository owner, or has the required explicit permission.
- Repository access is checked on every view, upload, download, file deletion, repository deletion, and permission-management request.
- Unauthorized repository requests return a generic not-found response to avoid exposing repository existence.
- Uploaded files receive generated storage names and are stored outside the public web directory.
- Stored file paths are resolved inside the repository-specific upload directory before use.
- File names shown to users are normalized and length-limited.
- File size and per-request file count limits are configurable.
- Session cookies, CSRF protection, Helmet headers, bcrypt password hashing, and login rate limiting are enabled.

## Technology

- Node.js 22.16.0 or newer with ES modules
- Express 5 and EJS
- SQLite through Node's built-in `node:sqlite` module
- Multer for multipart uploads
- `express-session` with a custom SQLite session store
- bcryptjs and Helmet
- Node's built-in test runner with Supertest

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

Change the administrator password and `SESSION_SECRET` before exposing the service. The bootstrap password is used only when no administrator account exists.

## Available commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the web server |
| `npm run dev` | Start with Node's watch mode |
| `npm test` | Run integration and permission tests |
| `npm run check` | Check the server entry file for syntax errors |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | Enables production cookie and proxy settings when set to `production` |
| `SESSION_SECRET` | Example value | Secret used to sign session cookies |
| `ADMIN_USERNAME` | `admin` | Username for the first administrator |
| `ADMIN_PASSWORD` | `ChangeMe123!` | Password for the first administrator |
| `ADMIN_DISPLAY_NAME` | `System Administrator` | Display name for the first administrator |
| `MAX_FILE_SIZE_MB` | `100` | Maximum size of one uploaded file in megabytes |
| `MAX_FILES_PER_UPLOAD` | `10` | Maximum files accepted in one upload request |
| `DB_PATH` | `./data/recorddrive.db` | SQLite database path |
| `UPLOAD_ROOT` | `./data/uploads` | Uploaded file storage directory |

Production mode refuses to start with the sample administrator password or an unsafe session secret.

## Docker

```bash
cp .env.example .env
docker compose up --build -d
```

The Compose configuration stores the database and uploaded files in the `recorddrive_data` volume.

To inspect service health:

```bash
curl http://localhost:3000/health
```

A healthy instance returns:

```json
{
  "status": "ok",
  "service": "RecordDrive"
}
```

## Project layout

```text
RecordDrive/
├── src/
│   ├── app.js
│   ├── config.js
│   ├── database.js
│   ├── repository-access.js
│   ├── repository-service.js
│   ├── session-store.js
│   ├── middleware/
│   └── routes/
├── views/
├── public/
├── data/
├── test/
├── Dockerfile
└── docker-compose.yml
```

## Deployment notes

Run the service behind an HTTPS reverse proxy with `NODE_ENV=production`. Keep secrets outside source control, protect the persistent data volume with filesystem permissions, and maintain regular backups.

This build targets a single application instance with local SQLite and disk storage. Multi-instance deployments require shared sessions, a networked database, and shared object storage. Malware scanning, file previews, quotas, public links, trash recovery, and nested folders are outside the current scope.
