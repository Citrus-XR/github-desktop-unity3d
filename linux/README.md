# Linux packaging

The fork ships an AUR-compatible PKGBUILD under `linux/aur/desktop-u/`
that clones this repo at a pinned commit, builds it with Node 24, and
installs the Electron tree to `/opt/desktop-u/` with a `.desktop`
launcher and hicolor icons. It coexists with shiftkey's
`github-desktop-bin` (different install path, different bundle name,
different `x-github-desktop-u://` URL scheme).

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

After install, launch from the KDE/GNOME menu ("GitHub Desktop U",
cyan **U** badge on the Octicat) or via `desktop-u` on the command
line.

**From AUR (once pushed):**

```sh
yay -S desktop-u
```

## Cut a new release of the PKGBUILD

For any commit worth handing to users, bump the pinned SHA in
`linux/aur/desktop-u/PKGBUILD`:

1. Push the change to `origin/development`, note the resulting SHA.
2. Edit `PKGBUILD`:
   - `source=(...)#commit=<sha>` — pin the new commit
   - `pkgver` — bump only if `app/package.json`'s version changed
     (AUR `pkgver` disallows `-`; rewrite as `.`, e.g. `3.5.13-beta2`
     → `3.5.13.beta2`)
   - `pkgrel` — reset to `1` when `pkgver` changes; increment when
     only the PKGBUILD itself changes at the same `pkgver`
3. Regenerate `.SRCINFO`:
   ```sh
   makepkg -D linux/aur/desktop-u --printsrcinfo > linux/aur/desktop-u/.SRCINFO
   ```
4. Commit `PKGBUILD` + `.SRCINFO`.

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

Subsequent updates: repeat the copy + commit + push. Users pick it up
via `yay -Syu` (or any other AUR helper).

## Why we bundle Node 24 instead of using system `nodejs`

Arch's current `nodejs` is 26.x. Its stream handling breaks
`extract-zip@2.0.1` — which ships inside `electron@42.0.1`'s
`postinstall` — mid-extract, so `node_modules/electron/dist/` ends up
holding just a `locales/` directory. `electron-packager` then exits
silently with no output and produces no app tree. The upstream
`.nvmrc` pins Node 24.15.0 to avoid this; the PKGBUILD downloads that
tarball via the `source=` array and prepends its `bin/` to PATH for
`prepare()` and `build()`. The user's system `nodejs` is not touched.

## Skipping Playwright's ffmpeg download

`script/post-install.ts` respects `DESKTOP_SKIP_PLAYWRIGHT=1` and
skips the `playwright install ffmpeg` step when set. The PKGBUILD
sets this in `prepare()` and `build()` because that download hangs
indefinitely on networks that can't reach
`playwright.download.prss.microsoft.com`, and Playwright is only used
by `yarn test:e2e:*` — not by the packaged app.
