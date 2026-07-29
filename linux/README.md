# Linux packaging

The fork ships an AUR-compatible PKGBUILD under `linux/aur/desktop-u/`
that clones this repo, builds it with Node 24, and installs the
Electron tree to `/opt/desktop-u/` with a `.desktop` launcher and
hicolor icons. It coexists with shiftkey's `github-desktop-bin`
(different install path, different bundle name, different
`x-github-desktop-u://` URL scheme).

The PKGBUILD tracks `origin/development`'s HEAD via a `pkgver()`
function that computes an Arch-legal version from `git describe`, so
`makepkg -si` on the same file picks up new commits as they land
upstream. No SHA to bump.

## Install

**Locally, without touching AUR:**

```sh
cd linux/aur/desktop-u
makepkg -si
```

First run downloads Node 24.15.0 (~40 MB), then yarn deps (~cached
after first run), then runs `yarn build:prod` (~5–10 minutes of
webpack + electron-packager). Produces
`desktop-u-<pkgver>-<pkgrel>-x86_64.pkg.tar.zst` and hands it to
pacman.

Re-run the same command later to upgrade — makepkg re-fetches the
tracked branch, `pkgver()` recomputes to something like
`3.6.3.beta2.r62.g<newsha>`, and pacman upgrades naturally. If the
tracked branch is unchanged pacman reports "up to date".

After install, launch from the KDE/GNOME menu ("GitHub Desktop U",
cyan **U** badge on the Octicat) or via `desktop-u` on the command
line.

**From AUR (once pushed):**

```sh
yay -S desktop-u
```

## Updating the PKGBUILD itself

Bump `pkgrel` only when the PKGBUILD (build recipe, dependency list,
install layout) changes without a matching upstream commit — pacman
uses `pkgrel` as the tiebreaker within the same `pkgver`. When a new
upstream commit lands, `pkgver()` recomputes a fresh version by
itself and `pkgrel` stays where it is; leave it alone.

To temporarily build a specific commit (bisect, reproducing a bug on
an older revision), swap the branch fragment for a commit fragment in
`source=`:

```
source=(
  "git+https://github.com/Citrus-XR/github-desktop-unity3d.git#commit=<sha>"
  ...
)
```

Regenerate `.SRCINFO` after any PKGBUILD edit so AUR helpers see the
new metadata:

```sh
cd linux/aur/desktop-u
makepkg --printsrcinfo > .SRCINFO
```

Commit `PKGBUILD` + `.SRCINFO` together. `makepkg` also rewrites the
top-level `pkgver=` field in `PKGBUILD` during a build — that edit is
throwaway state, don't commit it.

## Push to AUR

Prerequisite: an account at https://aur.archlinux.org with an SSH
public key registered under **My Account**.

```sh
# One-off: clone the empty AUR repo (AUR creates it on first push).
git clone ssh://aur@aur.archlinux.org/desktop-u.git /tmp/aur-desktop-u

# Copy the current PKGBUILD + .SRCINFO in.
cp linux/aur/desktop-u/{PKGBUILD,.SRCINFO} /tmp/aur-desktop-u/

# Sanity check the diff, commit, and push.
cd /tmp/aur-desktop-u
git add PKGBUILD .SRCINFO
git commit -m "…"
git push
```

Subsequent updates: repeat the copy + commit + push only when the
PKGBUILD itself changes (build steps, deps, install layout). Users
still get new upstream code via the branch-tracked `source=` on the
next `yay -Syu` even without a new AUR push, but their PKGBUILD copy
stays in sync only if we push updates.

## Why the desktop entry is named `github-desktop-u`

The package, the binary and the install prefix are all `desktop-u`, but
`linux/github-desktop-u.desktop` and the hicolor icons it references are
not. A desktop shell links a running window back to its launcher — and
so to its icon — by matching the app id the window reports against the
basename of a `.desktop` file. Electron derives that id from
`productName` ("GitHub Desktop U") by lowercasing it and replacing
spaces with hyphens, giving `github-desktop-u` for both the Wayland
`xdg_toplevel` app_id and the X11 `WM_CLASS`. Neither `--class` nor
`CHROME_DESKTOP=` changes it (both were tried against the packaged
build; the reported id stayed `github-desktop-u`), so the file has to
move to the app rather than the other way round. `StartupWMClass` and
`Icon` use the same id for consistency.

Naming the entry after the package instead leaves the window with a
blank icon in the task manager while the launcher in the application
menu looks fine — the menu reads the `.desktop` file directly and never
needs the match.

## Why we bundle Node 24 instead of using system `nodejs`

Arch's current `nodejs` is 26.x. Its stream handling breaks
`extract-zip@2.0.1` — which ships inside `electron@42.0.1`'s
`postinstall` — mid-extract, so `node_modules/electron/dist/` ends up
holding just a `locales/` directory. `electron-packager` then exits
silently with no output and produces no app tree. The upstream
`.nvmrc` pins Node 24.15.0 to avoid this; the PKGBUILD downloads that
tarball via the `source=` array and prepends its `bin/` to PATH for
`prepare()` and `build()`. The user's system `nodejs` is not touched.

## Why there is no `-debug` split package

`options=('!strip')` in the PKGBUILD disables stripping. Two reasons:

1. Electron ships its binaries already stripped upstream, so a
   `-debug` split would only capture residual symbols in libraries
   like `libffmpeg`, `chrome-sandbox`, etc. Every one of those is
   keyed by an Electron build-id that shiftkey's
   `github-desktop-bin-debug` also carries — the two `-debug`
   packages then collide file-for-file whenever we happen to bundle
   the same Electron version, and pacman refuses to install both.
2. Our own JS lives in text form under `/opt/desktop-u/resources/`,
   which no separate symbol package would help debug anyway.

## Skipping Playwright's ffmpeg download

`script/post-install.ts` respects `DESKTOP_SKIP_PLAYWRIGHT=1` and
skips the `playwright install ffmpeg` step when set. The PKGBUILD
sets this in `prepare()` and `build()` because that download hangs
indefinitely on networks that can't reach
`playwright.download.prss.microsoft.com`, and Playwright is only used
by `yarn test:e2e:*` — not by the packaged app.
