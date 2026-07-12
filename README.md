# GitHub Desktop for Unity

This is a desktop git manager application optimized for Unity!

* **Unity Semantic Diff**: Render semantic changes in `.unity`, `.prefab`, `.mat` like the Unity Inspector.
* You can switch back to the raw text diff at any time on the toolbar.

<!-- **Running on Linux (KDE/Wayland):** the dev launcher (`yarn start`) forces X11/XWayland (`--ozone-platform=x11`), because the native Wayland backend drops the in-window menu bar and mis-renders the frame under KDE. --->

<picture>
  <source
    srcset="https://user-images.githubusercontent.com/634063/202742848-63fa1488-6254-49b5-af7c-96a6b50ea8af.png"
    media="(prefers-color-scheme: dark)"
  />
  <img
    width="1072"
    src="https://user-images.githubusercontent.com/634063/202742985-bb3b3b94-8aca-404a-8d8a-fd6a6f030672.png"
    alt="A screenshot of the GitHub Desktop application showing changes being viewed and committed with two attributed co-authors"
  />
</picture>

## Install

- **Windows / macOS** — download a `GitHubDesktopUSetup-x64.{exe,msi}`
  or `GitHub Desktop U-<arch>.zip` artifact from a
  [CI run](https://github.com/Citrus-XR/github-desktop-unity3d/actions/workflows/ci.yml)
  triggered via **Run workflow** (`upload-artifacts=true` is the
  default). Signed builds require Azure code-signing secrets that
  this fork's CI doesn't have — the Windows installers will trip
  SmartScreen ("unknown publisher"); click **More info → Run anyway**.
- **Linux (Arch/AUR)** — see [`linux/README.md`](linux/README.md).
  Short form: `cd linux/aur/desktop-u && makepkg -si`.

It coexists with upstream GitHub Desktop and with shiftkey's Linux
`github-desktop-bin` — installs to distinct paths, uses its own
`x-github-desktop-u://` URL scheme, and its own OAuth app so
authorizing one doesn't step on the other.

## Unity Semantic Diff notes

Prefabs and scenes often reference objects *inside* imported model
files (FBX, OBJ, etc.), which Git can't see. To resolve those refs
this fork parses the raw FBX with
[`fbx-parser`](https://github.com/picode7/fbx-parser) (MIT) — for
the object hierarchy alone, no geometry — and reconstructs the
fileIDs Unity 2019+ generates for each object by hashing its
hierarchy path plus class name with
[`xxhashjs`](https://github.com/pierrec/js-xxhash) (MIT, Pierre
Curto). The exact algorithm was cross-validated against
[V-Sekai's `unidot_importer`](https://github.com/V-Sekai/unidot_importer),
whose Godot port re-derives the same ids for `.unitypackage`
conversion. Both dependencies stay pure JS — no native builds — so
the Electron packaging story is unaffected.

