#!/usr/bin/env bash
set -Eeuo pipefail

# 显式发布入口。普通 `git push` 不会调用本脚本，因此不会创建版本、tag 或 Release。

usage() {
  printf 'Usage: bash ./publish.sh [patch|minor|major]\n'
  printf 'Default bump: patch\n'
}

release_bump="${1:-patch}"
case "$release_bump" in
  patch|minor|major) ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

for release_command in git node npm gh; do
  if ! command -v "$release_command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$release_command" >&2
    exit 1
  fi
done

release_root="$(git rev-parse --show-toplevel)"
cd "$release_root"

release_branch="${RELEASE_BRANCH:-main}"
current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$release_branch" ]]; then
  printf 'Release must run on branch %s; current branch is %s.\n' "$release_branch" "$current_branch" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Working tree is not clean. Commit the intended release changes first.\n' >&2
  exit 1
fi

gh auth status >/dev/null
git fetch --tags origin "$release_branch"
if ! git merge-base --is-ancestor "origin/$release_branch" HEAD; then
  printf 'Local %s does not contain origin/%s. Rebase or merge before publishing.\n' "$release_branch" "$release_branch" >&2
  exit 1
fi

current_version="$(node -p 'require("./package.json").version')"
if [[ ! "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  printf 'publish.sh supports stable x.y.z versions; found %s.\n' "$current_version" >&2
  exit 1
fi
IFS='.' read -r release_major release_minor release_patch <<< "$current_version"

current_tag="v$current_version"
release_mode="new"
if git tag --points-at HEAD --list "$current_tag" | grep -Fxq "$current_tag"; then
  if gh release view "$current_tag" >/dev/null 2>&1; then
    printf 'HEAD is already published as %s; add new commits before the next release.\n' "$current_tag" >&2
    exit 1
  fi
  release_mode="resume"
fi

if [[ "$release_mode" == "new" ]]; then
  case "$release_bump" in
    patch) next_version="$release_major.$release_minor.$((release_patch + 1))" ;;
    minor) next_version="$release_major.$((release_minor + 1)).0" ;;
    major) next_version="$((release_major + 1)).0.0" ;;
  esac
  release_tag="v$next_version"
else
  next_version="$current_version"
  release_tag="$current_tag"
fi

release_npm_cache="${TMPDIR:-/tmp}/dsh-grafana-release-npm-cache"
npm --cache "$release_npm_cache" ci --ignore-scripts
npm --cache "$release_npm_cache" run verify
npm --cache "$release_npm_cache" pack --dry-run --ignore-scripts

printf '\n⚠️ 危险操作检测喵～\n'
printf '操作类型：Git release commit、tag、push 和 GitHub Release\n'
printf '影响范围：origin/%s 与标签 %s\n' "$release_branch" "$release_tag"
printf '风险评估：发布后版本号和公开历史不应随意改写\n'
printf '(有点紧张呢，请确认是否继续？) 输入“是”、“确认”或“继续”：'
read -r release_confirmation
case "$release_confirmation" in
  是|确认|继续) ;;
  *)
    printf 'Release cancelled.\n'
    exit 0
    ;;
esac

if [[ "$release_mode" == "new" ]]; then
  npm --cache "$release_npm_cache" version "$release_bump" -m 'chore(release): v%s'
  created_version="$(node -p 'require("./package.json").version')"
  if [[ "$created_version" != "$next_version" ]]; then
    printf 'Unexpected version after npm version: expected %s, got %s.\n' "$next_version" "$created_version" >&2
    exit 1
  fi
fi

git push --atomic origin "$release_branch" "$release_tag"

if gh release view "$release_tag" >/dev/null 2>&1; then
  printf 'GitHub Release %s already exists; leaving it unchanged.\n' "$release_tag"
else
  gh release create "$release_tag" \
    --verify-tag \
    --title "$release_tag" \
    --generate-notes
fi

printf '\nPublished %s successfully.\n' "$release_tag"
printf 'npm publication is intentionally disabled until the package owner account is configured.\n'
