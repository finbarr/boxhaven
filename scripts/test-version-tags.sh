#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/cmd/bh" "$fixture/deploy/digitalocean" "$fixture/bin"
cp "$repo_root/Makefile" "$fixture/Makefile"
cp "$repo_root/deploy/digitalocean/deploy-production.sh" "$fixture/deploy/digitalocean/"
touch "$fixture/deploy/digitalocean/docker-compose.yml" "$fixture/deploy/digitalocean/.env.production"
printf 'module version-test\n\ngo 1.23\n' > "$fixture/go.mod"
cat > "$fixture/cmd/bh/main.go" <<'GO'
package main
import "fmt"
var Version string
func main() { fmt.Println(Version) }
GO
cat > "$fixture/bin/docker" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *" exec -T backend node -e "*) printf '%s' "${BOXHAVEN_VERSION:?}" ;;
esac
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture/bin/curl"
printf '/bh\n' > "$fixture/.gitignore"
chmod +x "$fixture/bin/docker" "$fixture/bin/curl"
git -C "$fixture" init -q
git -C "$fixture" -c user.name=Test -c user.email=test@example.com add .
git -C "$fixture" -c user.name=Test -c user.email=test@example.com commit -qm 'CLI release'
git -C "$fixture" tag v0.2.0
git -C "$fixture" -c user.name=Test -c user.email=test@example.com commit --allow-empty -qm 'Skill release'
git -C "$fixture" tag boxhaven-skill-v1.0.0
expected="v0.2.0-1-g$(git -C "$fixture" rev-parse --short HEAD)"
make -s -C "$fixture" build
[ "$("$fixture/bh")" = "$expected" ] || { echo 'skill tag changed CLI version' >&2; exit 1; }
output="$(PATH="$fixture/bin:$PATH" "$fixture/deploy/digitalocean/deploy-production.sh" --local --verify-only)"
[[ "$output" == *"Backend version $expected"* ]] || { echo 'skill tag changed backend version' >&2; exit 1; }
echo 'CLI and backend versions ignore skill tags'
