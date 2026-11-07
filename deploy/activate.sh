#!/bin/sh
set -eu

root=$1
release=$2
directory="$root/releases/$release"
lock="$root/.deploy-lock"
mkdir "$lock" || { echo "Een andere Weekmand-update is bezig." >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
trap 'exit 1' HUP INT TERM

node="$root/runtime/node-v24.22.1-linux-arm64-musl/bin/node"
service=/etc/init.d/weekmand
"$node" --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; new DatabaseSync(":memory:").close();'
"$node" --check "$directory/src/server.ts"
chmod 755 "$root" "$root/releases"
chmod -R a+rX,go-w "$directory"
mkdir -p "$root/data"
chown 65534:65534 "$root/data"
chmod 700 "$root/data"

if [ ! -e "$root/config.env" ]; then
  umask 027
  touch "$root/config.env"
  chown 0:65534 "$root/config.env"
  chmod 640 "$root/config.env"
fi

if [ -e "$service" ] && ! cmp -s "$directory/deploy/weekmand.init" "$service"; then
  echo "De bestaande Weekmand-initservice wijkt af. Update afgebroken." >&2
  exit 1
fi

previous=
if [ -f "$root/current" ]; then
  read -r previous < "$root/current"
  case "$previous" in ''|*[!a-z0-9-]*) echo "Ongeldige actieve release." >&2; exit 1 ;; esac
  [ -f "$root/releases/$previous/src/server.ts" ] || exit 1
fi

activate() {
  printf '%s\n' "$1" > "$root/current.new"
  mv "$root/current.new" "$root/current"
}

healthy() {
  attempts=0
  while [ "$attempts" -lt 15 ]; do
    if uclient-fetch -q -T 2 -O - http://127.0.0.1:8080/health | grep -q '"ok":true'; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

if [ ! -e "$service" ]; then
  cp "$directory/deploy/weekmand.init" "$service"
  chmod 755 "$service"
fi

activate "$release"
if "$service" restart && healthy && "$service" enable; then
  printf 'Weekmand-release %s is actief.\n' "$release"
  exit 0
fi

echo "De nieuwe Weekmand-release werd niet gezond." >&2
if [ -n "$previous" ]; then
  activate "$previous"
  "$service" restart && healthy && echo "Vorige release opnieuw actief: $previous" >&2
else
  "$service" stop || true
  rm -f "$root/current"
fi
exit 1
