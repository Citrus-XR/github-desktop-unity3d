# Linux packaging

## Install from source with makepkg

```sh
cd linux/aur/desktop-u
makepkg -si
```

`makepkg` clones the repo at the commit pinned in `PKGBUILD`, runs
`yarn install --frozen-lockfile && yarn build:prod`, then packages the
resulting Electron tree into `/opt/desktop-u/` with an XDG `.desktop`
entry and hicolor icons. First build takes 5-10 minutes; subsequent
rebuilds hit yarn's cache.

## Bump for a new commit

1. Push the change to `origin/development`, note the SHA.
2. Edit `PKGBUILD`:
   - `pkgver` — bump if `app/package.json`'s version changed
     (AUR pkgver disallows `-`; rewrite as `.`, e.g. `3.5.13-beta2` →
     `3.5.13.beta2`)
   - `pkgrel` — reset to 1 when `pkgver` changes; increment when only
     the PKGBUILD itself changes at the same pkgver
   - `source=(...)#commit=<sha>` — pin the new commit
3. Regenerate `.SRCINFO`:
   ```sh
   cd linux/aur/desktop-u
   makepkg --printsrcinfo > .SRCINFO
   ```
4. Commit both files.

## Push to AUR

Prerequisite: an account at https://aur.archlinux.org and an SSH public
key registered under it.

```sh
# One-off: clone the empty AUR repo (AUR creates it on first push)
git clone ssh://aur@aur.archlinux.org/desktop-u.git /tmp/aur-desktop-u

# Copy the current PKGBUILD + .SRCINFO in
cp linux/aur/desktop-u/{PKGBUILD,.SRCINFO} /tmp/aur-desktop-u/

# Sanity check + push
cd /tmp/aur-desktop-u
git add PKGBUILD .SRCINFO
git commit -m "..."
git push
```

Subsequent updates: repeat the copy + commit + push. Users pick it up
via `yay -Syu desktop-u` (or any other AUR helper).
