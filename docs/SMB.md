# SMB access

RecordDrive can publish an enabled repository as an authenticated SMB 2/3 share on the local network. The web application remains the source of repository metadata, while the bundled Samba sidecar exposes a Windows-safe hard-link projection of the same file inodes.

## Deployment

Docker Compose enables the integration by default:

- RecordDrive writes repository projections to `/app/data/smb-shares` and control messages to `/app/data/smb-control`.
- The Samba sidecar mounts the same named volume at `/data`, persists its passdb in `recorddrive_smb_state`, and listens on TCP 445.
- Set `SMB_BIND_ADDRESS` to a specific trusted LAN address when the host has multiple interfaces.
- Set `SMB_SERVER_NAME` to the DNS name or LAN IP users should enter in File Explorer.

Do not publish TCP 445 to the public internet. Restrict it to a trusted local network with the host firewall. The Compose default publishes port 445 on all host interfaces so that LAN clients can connect; change `SMB_BIND_ADDRESS` when that is broader than intended.

For non-Docker deployments, install Samba separately and consume the generated manifest and credential commands in `SMB_CONTROL_ROOT`, or run the included sidecar with the same storage volume. `SMB_SHARE_ROOT` and `UPLOAD_ROOT` must reside on the same filesystem because RecordDrive uses hard links. Both paths must support regular hard links, and the SMB projection filesystem must support `user.*` extended attributes for Windows creation-time storage.

## Enabling a repository

1. Open **Repository settings** as the repository owner or a server administrator.
2. Confirm that the Samba sidecar reports ready and that its extended-attribute probe succeeds.
3. Enable **Windows SMB access**.
4. Choose writable or read-only access and set a repository-specific SMB password.
5. Enter the displayed UNC path in Windows File Explorer, for example `\\recorddrive-server\recorddrive-12`.
6. Sign in with the displayed repository account, for example `rd_repo_12`.

The SMB password is separate from every RecordDrive web password. Anyone who knows the repository SMB credential receives the share-level access selected in Repository settings; web permission grants are not mapped to separate Windows accounts.

The application writes a password once to a mode-0600 control command. The Samba sidecar consumes and deletes that command, then stores the credential in its persistent passdb. Disabling a share removes its passdb user and clears the credential state, so a new password is required when it is enabled again.

## Timestamp behavior

SMB carries creation, last-access, last-write, and change times through Windows file information structures. The sidecar uses `store dos attributes = yes`, allowing Samba to retain Windows creation time in `user.DOSATTRIB`, and `dos filetimes = yes` with full file-time resolution so writable clients can set their supplied values.

RecordDrive hard-links each SMB-visible file to its canonical stored file. Projection creation and synchronization therefore do not copy file contents into a second inode and do not rewrite creation, modification, or access times. Web reads open stored files with `O_NOATIME` where the operating system supports it, reducing access-time churn before the existing preservation policy runs.

The sidecar refreshes an application-readable heartbeat and extended-attribute probe in `data/smb-control/status.json`. RecordDrive blocks repository SMB activation until that status is recent and reports `xattrSupported: true`.

### Windows Explorer limitation

A normal File Explorer copy can create destination-side creation/access values instead of transmitting every source timestamp. An SMB server cannot reconstruct values that the client did not send. Use the bundled Windows helper whenever all three source times must match exactly:

```powershell
.\tools\windows\RecordDrive-Copy.ps1 `
  -Source 'D:\Archive' `
  -Destination '\\recorddrive-server\recorddrive-12\Archive'
```

For a move that deletes the source only after Robocopy reports success:

```powershell
.\tools\windows\RecordDrive-Copy.ps1 `
  -Source 'D:\Archive' `
  -Destination '\\recorddrive-server\recorddrive-12\Archive' `
  -Move
```

The helper:

1. Captures each source file and directory creation, last-write, and last-access value as Windows FILETIME before reading the data.
2. Copies with Robocopy `/COPY:DAT`, `/DCOPY:DAT`, and `/TIMFIX`.
3. Reapplies all three captured values to the destination, with directories processed deepest-first and the root last.
4. Reads the destination values back and fails unless every FILETIME is exactly equal.

Robocopy exit codes below 8 are treated as success; 8 or higher is a failure. Reparse points are rejected instead of followed.

## Synchronization model

- Web uploads and folders are projected into the SMB share.
- SMB-created files are hard-linked into RecordDrive storage and inserted into SQLite.
- SMB rename, move, overwrite, edit, and delete operations are reconciled back into RecordDrive.
- A projection marker distinguishes a lost/recreated projection volume from a user SMB delete, preventing canonical files from being deleted after projection storage loss.
- Symlinks, reparse-style links represented as Unix symlinks, non-regular filesystem objects, and folders deeper than the repository limit are removed from the projection.
- New SMB files and inode-replacement overwrites are checked against the configured per-file, repository-storage, service-storage, repository-file-count, service-file-count, folder-count, and depth limits. A rejected destination file is removed and an activity-log entry is written. Because an already-open hard-linked file can grow before RecordDrive observes the write, enforce hard capacity limits at the filesystem or volume layer when strict storage ceilings are required.
- Disabling SMB removes the share projection and passdb credential but leaves canonical stored files untouched.
- SMB-enabled repositories force the RecordDrive web access-time policy to preserve the stored access time.
- Repository storage relocation is blocked while any SMB share is enabled; disable all shares, move storage, then re-enable them so hard-link compatibility is revalidated.

The default reconciliation interval is one second and can be changed with `SMB_SYNC_INTERVAL_MS` (minimum 250 ms).

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMB_ENABLED` | `false` | Enables repository SMB settings and reconciliation |
| `SMB_SHARE_ROOT` | `./data/smb-shares` | Host/application projection root |
| `SMB_CONTROL_ROOT` | `./data/smb-control` | Manifest, status, and one-time credential commands |
| `SMB_CONTAINER_SHARE_ROOT` | `/data/smb-shares` | Projection root as seen by Samba |
| `SMB_SERVER_NAME` | `recorddrive` fallback | DNS name or LAN IP displayed in UNC paths |
| `SMB_SYNC_INTERVAL_MS` | `1000` | Reconciliation interval |
| `SMB_BIND_ADDRESS` | `0.0.0.0` in Compose | Host interface used for TCP 445 publication |
