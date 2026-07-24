FROM alpine:3.24

RUN apk add --no-cache \
      attr \
      jq \
      samba \
      samba-client \
      samba-common-tools \
      shadow \
      tini

COPY entrypoint.sh /usr/local/bin/recorddrive-smb-entrypoint
RUN chmod 0755 /usr/local/bin/recorddrive-smb-entrypoint

EXPOSE 445
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/recorddrive-smb-entrypoint"]
