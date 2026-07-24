#!/bin/sh
set -eu

CONTROL_ROOT="${SMB_CONTROL_ROOT:-/data/smb-control}"
SHARE_ROOT="${SMB_SHARE_ROOT:-/data/smb-shares}"
STATE_ROOT="${SMB_STATE_ROOT:-/var/lib/samba}"
DATA_ROOT="${RECORDDRIVE_DATA_ROOT:-/data}"
RECORDDRIVE_UID="${RECORDDRIVE_UID:-1000}"
RECORDDRIVE_GID="${RECORDDRIVE_GID:-1000}"
CONFIG_PATH=/etc/samba/smb.conf
SHARES_PATH=/etc/samba/shares.conf

mkdir -p "$DATA_ROOT" "$CONTROL_ROOT/credentials" "$SHARE_ROOT" \
  "$STATE_ROOT/state" "$STATE_ROOT/cache" "$STATE_ROOT/lock" "$STATE_ROOT/private" /run/samba
chmod 0700 "$CONTROL_ROOT" "$CONTROL_ROOT/credentials" "$SHARE_ROOT"

if ! getent group recorddrive >/dev/null 2>&1; then
  addgroup -g "$RECORDDRIVE_GID" recorddrive
fi
if ! getent passwd recorddrive >/dev/null 2>&1; then
  adduser -D -H -s /sbin/nologin -u "$RECORDDRIVE_UID" -G recorddrive recorddrive
fi
chown recorddrive:recorddrive "$DATA_ROOT"
chown recorddrive:recorddrive "$CONTROL_ROOT" "$CONTROL_ROOT/credentials" "$SHARE_ROOT"
chmod 0700 "$DATA_ROOT"
chmod 0700 "$CONTROL_ROOT" "$CONTROL_ROOT/credentials" "$SHARE_ROOT"

cat > "$CONFIG_PATH" <<EOF_CONFIG
[global]
  server role = standalone server
  workgroup = WORKGROUP
  netbios name = RECORDDRIVE
  server string = RecordDrive SMB
  security = user
  map to guest = Never
  passdb backend = tdbsam
  smb ports = 445
  disable netbios = yes
  server min protocol = SMB2_10
  server max protocol = SMB3
  server signing = mandatory
  smb encrypt = desired
  ea support = yes
  store dos attributes = yes
  dos filetimes = yes
  dos filetime resolution = no
  unix extensions = no
  smb3 unix extensions = no
  follow symlinks = no
  wide links = no
  load printers = no
  printing = bsd
  printcap name = /dev/null
  disable spoolss = yes
  log file = /dev/stdout
  logging = file
  max log size = 0
  state directory = $STATE_ROOT/state
  cache directory = $STATE_ROOT/cache
  lock directory = $STATE_ROOT/lock
  private dir = $STATE_ROOT/private
  pid directory = /run/samba
  include = $SHARES_PATH
EOF_CONFIG

: > "$SHARES_PATH"
chmod 0600 "$CONFIG_PATH" "$SHARES_PATH"

write_status() {
  xattr_ok=false
  probe="$SHARE_ROOT/.recorddrive-xattr-probe"
  : > "$probe"
  if setfattr -n user.recorddrive.probe -v ok "$probe" 2>/dev/null \
    && [ "$(getfattr --only-values -n user.recorddrive.probe "$probe" 2>/dev/null || true)" = "ok" ]; then
    xattr_ok=true
  fi
  rm -f "$probe"
  tmp="$CONTROL_ROOT/.status.json.$$"
  jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson xattr "$xattr_ok" \
    '{version:1, generatedAt:$generatedAt, xattrSupported:$xattr, protocolMin:"SMB2_10", protocolMax:"SMB3"}' \
    > "$tmp"
  chmod 0600 "$tmp"
  chown recorddrive:recorddrive "$tmp"
  mv -f "$tmp" "$CONTROL_ROOT/status.json"
}

ensure_smb_user() {
  username="$1"
  password="$2"
  printf '%s' "$username" | grep -Eq '^rd_repo_[0-9]+$' || {
    echo "Rejected invalid RecordDrive SMB username: $username" >&2
    return 1
  }
  if ! getent passwd "$username" >/dev/null 2>&1; then
    adduser -D -H -s /sbin/nologin "$username"
  fi
  printf '%s\n%s\n' "$password" "$password" | smbpasswd -s -a "$username" >/dev/null
  smbpasswd -e "$username" >/dev/null 2>&1 || true
}

remove_smb_user() {
  username="$1"
  printf '%s' "$username" | grep -Eq '^rd_repo_[0-9]+$' || return 1
  smbpasswd -x "$username" >/dev/null 2>&1 || true
  deluser "$username" >/dev/null 2>&1 || true
}

consume_credentials() {
  for command in "$CONTROL_ROOT"/credentials/*.json; do
    [ -f "$command" ] || continue
    action="$(jq -r '.action // empty' "$command" 2>/dev/null || true)"
    username="$(jq -r '.username // empty' "$command" 2>/dev/null || true)"
    case "$action" in
      set)
        password="$(jq -r '.password // empty' "$command" 2>/dev/null || true)"
        if [ -n "$username" ] && [ -n "$password" ]; then
          if ensure_smb_user "$username" "$password"; then
            rm -f "$command"
          else
            echo "Failed to apply SMB credential command: $command" >&2
            mv -f "$command" "$command.failed"
          fi
        else
          echo "Rejected malformed SMB credential command: $command" >&2
          mv -f "$command" "$command.rejected"
        fi
        ;;
      delete)
        if [ -n "$username" ]; then
          if remove_smb_user "$username"; then
            rm -f "$command"
          else
            echo "Failed to remove SMB credential: $command" >&2
            mv -f "$command" "$command.failed"
          fi
        else
          mv -f "$command" "$command.rejected"
        fi
        ;;
      *)
        echo "Rejected unknown SMB credential command: $command" >&2
        mv -f "$command" "$command.rejected"
        ;;
    esac
  done
}

generate_shares() {
  manifest="$CONTROL_ROOT/shares.json"
  tmp="$SHARES_PATH.tmp"
  : > "$tmp"
  if [ -f "$manifest" ] && jq -e '.version == 1 and (.shares | type == "array")' "$manifest" >/dev/null 2>&1; then
    jq -c '.shares[]' "$manifest" | while IFS= read -r share; do
      repository_id="$(printf '%s' "$share" | jq -r '.repositoryId')"
      share_name="$(printf '%s' "$share" | jq -r '.shareName')"
      username="$(printf '%s' "$share" | jq -r '.username')"
      share_path="$(printf '%s' "$share" | jq -r '.path')"
      read_only="$(printf '%s' "$share" | jq -r '.readOnly')"
      printf '%s' "$repository_id" | grep -Eq '^[0-9]+$' || continue
      printf '%s' "$share_name" | grep -Eq '^recorddrive-[0-9]+$' || continue
      printf '%s' "$username" | grep -Eq '^rd_repo_[0-9]+$' || continue
      [ "$share_name" = "recorddrive-$repository_id" ] || continue
      [ "$username" = "rd_repo_$repository_id" ] || continue
      [ "$read_only" = "true" ] || [ "$read_only" = "false" ] || continue
      [ "$share_path" = "$SHARE_ROOT/$repository_id" ] || continue
      [ -d "$share_path" ] || mkdir -p "$share_path"
      chown recorddrive:recorddrive "$share_path"
      chmod 0700 "$share_path"
      writable=yes
      [ "$read_only" = "true" ] && writable=no
      cat >> "$tmp" <<EOF_SHARE

[$share_name]
  path = $share_path
  browseable = yes
  read only = $read_only
  writable = $writable
  guest ok = no
  valid users = $username
  force user = recorddrive
  force group = recorddrive
  create mask = 0600
  force create mode = 0600
  directory mask = 0700
  force directory mode = 0700
  inherit permissions = no
  nt acl support = no
  map archive = no
  map hidden = no
  map system = no
  map readonly = no
  preserve case = yes
  short preserve case = yes
  case sensitive = auto
  store dos attributes = yes
  dos filetimes = yes
  dos filetime resolution = no
  vfs objects = streams_xattr
  strict sync = yes
  sync always = yes
  oplocks = yes
  level2 oplocks = yes
  veto files = /.recorddrive-projection/
  delete veto files = no
EOF_SHARE
    done
  fi
  chmod 0600 "$tmp"
  backup="$SHARES_PATH.previous"
  cp -f "$SHARES_PATH" "$backup"
  mv -f "$tmp" "$SHARES_PATH"
  if testparm -s "$CONFIG_PATH" >/dev/null 2>&1; then
    rm -f "$backup"
    smbcontrol all reload-config >/dev/null 2>&1 || true
  else
    echo "Generated SMB share configuration failed validation; keeping previous config." >&2
    mv -f "$backup" "$SHARES_PATH"
  fi
}

watch_control() {
  previous_hash=''
  last_status_epoch=0
  while :; do
    consume_credentials
    current_hash="$(sha256sum "$CONTROL_ROOT/shares.json" 2>/dev/null | awk '{print $1}' || true)"
    if [ "$current_hash" != "$previous_hash" ]; then
      generate_shares
      previous_hash="$current_hash"
    fi
    now_epoch="$(date +%s)"
    if [ $((now_epoch - last_status_epoch)) -ge 5 ]; then
      if write_status; then
        last_status_epoch="$now_epoch"
      else
        echo "Failed to refresh the RecordDrive SMB runtime status." >&2
      fi
    fi
    sleep 1
  done
}

write_status
consume_credentials
generate_shares
watch_control &
exec smbd --foreground --no-process-group --debug-stdout
