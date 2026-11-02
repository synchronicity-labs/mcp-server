#!/usr/bin/env bash
# Installs the pnpm version pinned in package.json for a GitHub Actions job:
# GitHub Releases first, then the npm registry. Needs RUNNER_TEMP and
# GITHUB_PATH, and runs from the repository root.
set -euo pipefail

version="$(sed -nE 's/^[[:space:]]*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@([^"+]+)(\+[^" ]+)?"[[:space:]]*,?[[:space:]]*$/\1/p' package.json | head -n 1)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unable to determine a pinned pnpm version from package.json." >&2
  exit 1
fi

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) asset="pnpm-linux-x64.tar.gz"; npm_platforms="exe.linux-x64 linux-x64" ;;
  Linux:aarch64|Linux:arm64) asset="pnpm-linux-arm64.tar.gz"; npm_platforms="exe.linux-arm64 linux-arm64" ;;
  Darwin:x86_64) asset="pnpm-darwin-x64.tar.gz"; npm_platforms="exe.darwin-x64 macos-x64" ;;
  Darwin:arm64) asset="pnpm-darwin-arm64.tar.gz"; npm_platforms="exe.darwin-arm64 macos-arm64" ;;
  *)
    echo "Unsupported runner platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

# The standalone binary needs neither Node.js nor Corepack, so putting its
# directory on PATH is the whole install.
install_dir="$RUNNER_TEMP/pnpm/$version"
mkdir -p "$install_dir"
binary_path="$install_dir/pnpm"
fetch_from_github() {
  # --retry alone skips dropped connections (curl exit 56 or 92).
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 \
    "https://github.com/pnpm/pnpm/releases/download/v$version/$asset" \
    --output "$RUNNER_TEMP/$asset" &&
    tar -xzf "$RUNNER_TEMP/$asset" -C "$install_dir"
}

# The npm registry publishes the release binary as @pnpm/exe.<platform>, or as
# @pnpm/<platform> for some 11.x releases (11.9.0 among them), and the bundled
# node-gyp in @pnpm/exe.
fetch_from_npm() {
  local pack_dir npm_platform
  pack_dir="$(mktemp -d "$RUNNER_TEMP/pnpm-npm-pack.XXXXXX")" || return 1
  for npm_platform in $npm_platforms; do
    if (cd "$pack_dir" && npm pack --loglevel error --registry https://registry.npmjs.org/ \
      "@pnpm/exe@$version" "@pnpm/$npm_platform@$version" > /dev/null 2>&1); then
      tar -xzf "$pack_dir/pnpm-exe-$version.tgz" -C "$install_dir" --strip-components=1 package/dist &&
        tar -xzf "$pack_dir/pnpm-$npm_platform-$version.tgz" -C "$install_dir" --strip-components=1 package/pnpm &&
        return 0
    fi
  done
  return 1
}

if ! fetch_from_github; then
  echo "::warning::Could not download pnpm $version from GitHub Releases. Falling back to the npm registry."
  if ! fetch_from_npm; then
    echo "::error::Unable to download pnpm $version from GitHub Releases or the npm registry." >&2
    exit 1
  fi
fi
chmod 755 "$binary_path"

echo "$install_dir" >> "$GITHUB_PATH"
actual_version="$("$binary_path" --version)"
if [[ "$actual_version" != "$version" ]]; then
  echo "Downloaded pnpm version $actual_version does not match $version." >&2
  exit 1
fi
echo "pnpm $actual_version"
