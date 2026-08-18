#!/usr/bin/env bash
set -Eeuo pipefail

# 发布流程（三步走）：
#
#   ./deploy.sh release  --->  锁版本：交互输入版本号，自动完成
#                              递增版本、提交、打tag、推送GitHub（仅限main分支）
#
#   ./deploy.sh build    --->  打包：验证代码 + npm pack，产物输出到 dist/
#                              （纯JS插件，无编译步骤）
#
#   ./deploy.sh publish  --->  分发：凭证校验后，先将安装包发布到 npm，
#                              再创建GitHub Release并上传同一产物
#
# 不运行本脚本时，日常提交推送完全不受影响。
# 发布新版本时按 release → build → publish 三步执行，版本号由脚本维护，无需手改任何文件。

######################################
# 全局配置
######################################
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
NPM_CACHE="${TMPDIR:-/tmp}/dsh-grafana-deploy-npm-cache"
NPM_PKG="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"
GIT_TAG="v${VERSION}"

######################################
# 通用工具函数
######################################
banner() { printf '\n--------- %s ---------\n' "$1"; }

die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

need_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "缺少命令：${c}，请先安装"
  done
}

confirm() {
  local answer=""
  printf '%s' "$1"
  read -r answer || true
  [[ "$answer" == "y" ]]
}

# 分支守卫：发布链路命令仅允许在 main 分支执行，防止误操作
guard_main() {
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "$RELEASE_BRANCH" ]] || die "发布相关命令仅允许在 $RELEASE_BRANCH 分支执行（当前分支：${branch}）"
}

# tag 守卫：确认当前版本已通过 release 锁定在 HEAD 上
guard_tag() {
  git tag --points-at HEAD | grep -Fxq "$GIT_TAG" || {
    die "当前HEAD上不存在tag ${GIT_TAG}，请先执行 ./deploy.sh release 锁定版本"
  }
}

verify_and_install() {
  npm --cache "$NPM_CACHE" ci --ignore-scripts
  npm --cache "$NPM_CACHE" run verify
}

######################################
# 帮助
######################################
usage() {
  cat <<'EOF'

用法：./deploy.sh <release|build|publish>

发布流程（三步走）：
  ./deploy.sh release  ->  锁版本：交互输入版本号（patch/minor/major 或 x.y.z），自动提交/打tag/推送
  ./deploy.sh build    ->  打包：验证 + npm pack，产物输出到 dist/（纯JS插件，无编译步骤）
  ./deploy.sh publish  ->  分发：先将 dist/ 安装包发布到 npm，再创建 GitHub Release 上传同一产物

以上命令仅限 main 分支执行，其它分支会被强制拦截；
日常开发时随意提交推送，互不影响。

发布前需完成 gh auth login 和 npm login；npm 账号需开启写操作2FA
（OTP 可交互输入，也可用 NPM_OTP 环境变量传入）。

EOF
}

######################################
# 子命令：锁版本（交互式，只能在main分支执行）
# 自动完成：版本校验 → 输入新版本号 → 代码验证 → 提交 → 打tag → 推送GitHub
######################################
cmd_release() {
  banner '开始锁定版本'
  need_cmd git node npm gh
  guard_main

  # 工作区必须干净（版本辐射要产生唯一明确的release commit）
  [[ -z "$(git status --porcelain)" ]] || die "工作区存在未提交变更，请先提交或stash"

  gh auth status >/dev/null
  git fetch --tags origin "$RELEASE_BRANCH"
  git merge-base --is-ancestor "origin/$RELEASE_BRANCH" HEAD || {
    die "本地 $RELEASE_BRANCH 未包含 origin/${RELEASE_BRANCH}，请先 rebase 或 merge"
  }

  # 解析新版本号：参数指定 或 交互输入；支持 patch/minor/major 或显式 x.y.z，回车默认 patch
  local input="${1:-}"
  if [[ -z "$input" ]]; then
    printf '当前版本：%s\n请输入要发布的版本号（如 0.3.3 / 0.4.0，重锁可输入当前版本号，回车默认 patch）：' "$VERSION"
    read -r input || true
    input="${input:-patch}"
  fi
  case "$input" in
    patch|minor|major) ;;
    *) [[ "$input" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版本号格式必须是 x.y.z 或 patch/minor/major" ;;
  esac

  # 计算目标版本
  local major minor patch next
  [[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "当前版本 $VERSION 不是标准的 x.y.z"
  major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
  case "$input" in
    patch) next="$major.$minor.$((patch + 1))" ;;
    minor) next="$major.$((minor + 1)).0" ;;
    major) next="$((major + 1)).0.0" ;;
    *) next="$input" ;;
  esac
  local next_tag="v$next"

  # 重锁检测：目标tag是否已存在于远端
  local relock="false"
  if [[ -n "$(git ls-remote --tags origin "refs/tags/$next_tag")" ]]; then
    relock="true"
    if gh release view "$next_tag" >/dev/null 2>&1; then
      die "$next_tag 已发布过 GitHub Release，请递增新版本号"
    fi
  fi

  # 确认
  if [[ "$relock" == "true" ]]; then
    confirm "确认重锁 ${next_tag}（tag 将强制移动到当前HEAD）？[y/N] " || { printf '已取消\n'; exit 0; }
  else
    confirm "确认发布 ${next_tag}（当前 v$VERSION → ${next_tag}）？[y/N] " || { printf '已取消\n'; exit 0; }
  fi

  # 发布前完整验证
  verify_and_install

  # 版本辐射 + 提交 + 打tag（next == VERSION 时为纯重锁：跳过npm version，仅移动tag）
  if [[ "$next" != "$VERSION" ]]; then
    git tag -d "$next_tag" >/dev/null 2>&1 || true
    printf '>> 递增版本并提交：%s\n' "$next_tag"
    npm --cache "$NPM_CACHE" version "$next" -m 'release: v%s'
  else
    printf '>> 版本号无变化，跳过提交\n'
  fi
  git tag -af "$next_tag" -m "release: $next_tag"

  # 推送 main 和 tag（重锁时tag会强制更新）
  printf '>> 推送 %s 和 tag 到远程\n' "$RELEASE_BRANCH"
  if [[ "$relock" == "true" ]]; then
    git push origin "$RELEASE_BRANCH"
    git push -f origin "refs/tags/$next_tag"
  else
    git push --atomic origin "$RELEASE_BRANCH" "$next_tag"
  fi

  banner "版本已锁定：$next_tag"
  printf '>> 下一步执行 ./deploy.sh build 和 ./deploy.sh publish 开始打包和分发\n'
}

######################################
# 子命令：打包（验证 + npm pack，纯JS插件无编译步骤）
# 前置条件：已执行过 ./deploy.sh release
######################################
cmd_build() {
  banner '开始验证打包'
  need_cmd node npm
  guard_main
  guard_tag

  # 纯JS插件没有编译步骤，这里做发布前的完整验证并产出npm安装包
  verify_and_install

  printf '>> 打包产物到 dist/\n'
  rm -rf dist
  mkdir -p dist
  npm --cache "$NPM_CACHE" pack --pack-destination dist --ignore-scripts

  banner "打包完成：$GIT_TAG"
  ls -alh dist/*.tgz
  printf '>> 下一步执行 ./deploy.sh publish 开始分发\n'
}

######################################
# 子命令：分发（发布安装包到npm + 创建GitHub Release并上传同一产物）
# 前置条件：已执行过 ./deploy.sh build
######################################
cmd_publish() {
  banner '开始分发'
  need_cmd gh npm
  guard_main
  guard_tag
  gh auth status >/dev/null
  npm whoami >/dev/null 2>&1 || die "未登录 npm，请先执行 npm login（账号需为写操作开启2FA）"

  # build 每次都会重建 dist/，其中只有一个 .tgz 产物
  local asset
  asset="$(find ./dist -maxdepth 1 -name '*.tgz' 2>/dev/null | head -n 1)"
  [[ -n "$asset" ]] || die "缺少打包产物 dist/*.tgz，请先执行 ./deploy.sh build"

  # npm 版本不可变：已发布过的版本直接跳过 npm 步骤，保证失败后可安全重跑
  local npm_done="false"
  if npm view "${NPM_PKG}@${VERSION}" version >/dev/null 2>&1; then
    npm_done="true"
    printf '>> npm 上已存在 %s@%s，本次仅创建 GitHub Release\n' "$NPM_PKG" "$VERSION"
  fi

  if gh release view "$GIT_TAG" >/dev/null 2>&1; then
    die "GitHub Release $GIT_TAG 已存在，如需重传请先在 GitHub 上删除"
  fi

  if [[ "$npm_done" == "true" ]]; then
    confirm "确认创建 GitHub Release $GIT_TAG 并上传 $(basename "$asset")？[y/N] " || { printf '已取消\n'; exit 0; }
  else
    confirm "确认发布 ${NPM_PKG}@${VERSION} 到 npm，并创建 GitHub Release $GIT_TAG 上传同一产物？[y/N] " || { printf '已取消\n'; exit 0; }
  fi

  # 先发 npm（不可变），再建 GitHub Release：任一步失败后重跑都不会重复发布
  if [[ "$npm_done" == "false" ]]; then
    printf '>> 发布 %s 到 npm（开启写操作2FA时会交互提示输入OTP）\n' "$(basename "$asset")"
    npm --cache "$NPM_CACHE" publish "$asset" --access public --ignore-scripts ${NPM_OTP:+--otp="$NPM_OTP"}
  fi

  printf '>> 创建 GitHub Release %s 并上传 %s\n' "$GIT_TAG" "$(basename "$asset")"
  gh release create "$GIT_TAG" \
    --verify-tag \
    --title "$GIT_TAG" \
    --generate-notes \
    "$asset"

  banner "$GIT_TAG 发布完成"
  printf 'npm: https://www.npmjs.com/package/%s/v/%s\n' "$NPM_PKG" "$VERSION"
}

######################################
# 入口：分发子命令；无参数时只显示帮助
######################################
cd "$(git rev-parse --show-toplevel)"

case "${1:-}" in
  release) shift; cmd_release "$@" ;;
  build)   cmd_build ;;
  publish) cmd_publish ;;
  -h|--help|help|'') usage ;;
  *) usage >&2; exit 2 ;;
esac
