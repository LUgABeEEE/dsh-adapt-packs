# dsh-adapt-packs

**Opt-in adaptation packs for the DSH mobile surface.**

Third-party plugin panels on a phone have three problems a plugin cannot fix from inside its own component: touch targets a thumb cannot hit, a panel root wider than the phone's content box, and rows hidden underneath a floating widget. This repository is a small registry of fixes for exactly those, delivered as packs that `dsh-mobile` loads through its public `extensions/` directory — plus a [compatibility list](compat.json) recording, per third-party plugin, whether it is usable on a phone as shipped, needs one of these packs, should be fixed upstream, or cannot be fixed from outside at all.

Nothing here forks or patches an installed DSH or dsh-mobile. A pack is a directory:

```
$DSH_HOME/mobile-access/extensions/<id>/
├── extension.json      # schemaVersion, id, name, version, description — exactly these five
├── mobile.css          # injected by the host
├── mobile.js           # optional; window.dshMobile.define({ apiVersion: 1, id, activate })
└── README.md           # ignored at runtime
```

Copy it in and the host picks it up within two seconds; move it out and it is gone. No restart, no configuration file, no second auth model.

## One plugin, many packs

`dsh-mobile` never receives an adaptation pack of its own: the complete deployment is
**dsh-mobile + this package**. The host contributes exactly its public `extensions/` directory and
the runtime that injects `mobile.css` / `mobile.js`; everything that decides *what* a phone adapts
lives here — packs, `catalog.json`, the [compatibility list](compat.json), the settings panel that
offers one-click installs, and the CLI.

For a full set the host only needs to see one extension:

```bash
npm run bundle                                        # build/dsh-ui-optimizer/
node tools/install.mjs plugin build/dsh-ui-optimizer --yes
```

`tools/bundle.mjs` rewrites each pack's `define()` into a collector and registers a single id, so
the packs stay the unit of development and verification while the bundle is the unit of
installation. Packs can still be installed one at a time (`node tools/install.mjs pack <id>`), and
`build/` is generated, not source.

## Where things live

Two repositories make the deployment: `saya-ch/dsh-mobile` is the host and contributes only its
`mobile-access/extensions/` runtime and the capabilities a pack cannot supply; this repository owns
every pack, the catalog, the compatibility list, the panel and the tooling. The boundary and the
change policy are written down in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the short version
is "adaptation content stays here, the host gets interfaces only".

## The packs

| pack | scope | what it does |
| --- | --- | --- |
| [`core-panel`](packs/core-panel/) | plugin panels | 44px hit floor inside a panel — the only source on 0.8.x, and a fallback that backs off once the host ships its own floor (#319); icon-only button width; width reclaim |
| [`shell-chrome`](packs/shell-chrome/) | the shell itself | both drawer states: docked session/project rows (`role="treeitem"`, 32/34 → 44px), rail icon buttons and the drawer's own toggle (36×36 / 28×28 → 44×44, width included); the "back to conversation" bar becomes a rise-only floor that never shrinks the host's own 48px |
| [`floaters`](packs/floaters/) | floating widgets | measures bottom-right fixed widgets, reserves their height, so the last rows stop hiding underneath |
| [`dshmarket-mobile`](packs/dshmarket-mobile/) | the plugin market panel | a 44px touch floor for `dshmarket` 1.73.x: buttons, icon buttons and the search field, scoped to `[data-dsh-market-root]` |
| [`dsh-context-mobile`](packs/dsh-context-mobile/) | the context/cost panel | a 44px touch floor for `dsh-context` 0.79.x on **dsh-mobile 0.8.x only** (0.8.1+ provides the same floor and the pack backs off): granularity buttons, icon-only clear button, search/select and custom `role=button` rows; located through the plugin's own `data-lc-*` attributes, scoped by this pack's marker |
| [`host-service-panel-mobile`](packs/host-service-panel-mobile/) | the host-observability panel | narrow-screen layout and a 44px touch floor for `dsh-host-service-panel` 0.7.x, scoped to `[data-dsh-hsp-root]` |

Every pack is **experimental** and **off by default**. `catalog.json` records, per pack, what has actually been verified and what has not — the `evidence` field is meant to be read before trusting one.

## The compatibility list

Not every plugin can be fixed from the outside — and "this one is fine on a phone" is worth writing down too. [`compat.json`](compat.json) records one verdict per third-party plugin:

```bash
dsh-adapt-packs compat                  # the whole list
dsh-adapt-packs compat --verdict pack    # only entries this repository has a pack for
```

| verdict | meaning |
| --- | --- |
| `native` | usable on a phone as shipped |
| `pack` | this repository has a pack for it (`pack` names it) |
| `upstream` | fixable, but only by the plugin author |
| `blocked` | not fixable from outside (canvas, native widgets, no reachable DOM) |

Every entry carries the version it was judged on, what the phone actually does (numbers where possible) and how strong the evidence is — measured, code-read, or not verified. Format and rules: [`docs/兼容清单.md`](docs/兼容清单.md). To suggest an entry, open the [compat suggestion](https://github.com/LUgABeEEE/dsh-adapt-packs/issues/new?template=compat-suggestion.yml) issue and bring numbers rather than adjectives.

`dsh-adapt-packs status` answers the other question — which packs this machine has installed, which are disabled, and which are in the catalog but not installed.

## Install

### From npm

```bash
npm install -g dsh-adapt-packs

dsh-adapt-packs list                          # what is in the catalog
dsh-adapt-packs install core-panel --dry-run  # plan only
dsh-adapt-packs install core-panel --yes      # write into $DSH_HOME
dsh-adapt-packs uninstall core-panel --yes    # move it out (reversible)
```

The published tarball carries `packs/`, `catalog.json`, `docs/` and the tooling,
including the evidence screenshots under `packs/<id>/shots/` (tarball ≈ 700 KB).
`dsh-adapt-packs check` runs the same harness as the repository.

### Inside DSH (the settings panel)

The package is also a DSH bundle: install it the usual way and a **插件适配** section appears in Settings, where the catalog, the installed state and the compatibility list are one click apart.

```bash
dsh plugin add dsh-adapt-packs        # or install the tarball from the market
```

It uses the same `lib/store.mjs` as the CLI, so the panel cannot disagree with `dsh-adapt-packs status`. The host route is `/api/adapt-packs/{state,install,uninstall}`; nothing else is exposed.

### From a checkout

```bash
node tools/check-pack.mjs                     # validate every pack first
node tools/install.mjs pack core-panel --dry-run
node tools/install.mjs pack core-panel --yes
node tools/install.mjs --uninstall core-panel --yes

# or install the whole set as one extension
node tools/bundle.mjs
node tools/install.mjs plugin build/dsh-ui-optimizer --yes
```

`install.mjs` defaults to a dry run, resolves `$DSH_HOME` (or `~/.dsh`), refuses to overwrite an existing pack, and moves an uninstalled pack to `mobile-access-adapt-disabled/` so it can be restored.

## Windows

`tools/` are plain Node scripts (Node 20+); nothing here assumes a POSIX shell, `/tmp`, or case-sensitive paths, and the commands work unchanged in PowerShell. The fixture checker needs Playwright and its Chromium build:

```powershell
npm install --no-save --no-package-lock playwright
npx playwright install chromium      # downloads into %LOCALAPPDATA%\ms-playwright
```

`check-pack.mjs` resolves Playwright in this order and lists every path it tried when it fails: `DSH_PLAYWRIGHT` (a `playwright/index.js` file **or** the `playwright` package directory) → `$DSH_HOME/profiles/{web,desktop,headless}/node_modules/playwright` → this repository's own `node_modules` → normal module resolution. A missing Chromium produces a message that points at `npx playwright install chromium` and at the expected browser cache (`%LOCALAPPDATA%\ms-playwright` on Windows).

Set the home directory with PowerShell syntax — the POSIX `export` form does not apply:

```powershell
$env:DSH_HOME = 'C:\Users\you\.dsh'   # default when unset: %USERPROFILE%\.dsh
```

`install.mjs` derives `mobile-access\extensions\<id>` from it and moves an uninstalled pack to `mobile-access-adapt-disabled\<id>`. Paths with a leading `~` are expanded, and `\` and `/` are both accepted where a pack path is expected. Existing pack directories are resolved case-insensitively (`PACKS\CORE-PANEL` is `packs/core-panel`), while pack ids and `catalog.json` lookups stay lowercase. CRLF checkouts are supported: the `windows-latest` job in CI runs the whole fixture suite from a CRLF working tree on every push/PR.

One path is not exercised by a normal install: the EXDEV fallback in `install.mjs` (copy + delete instead of `rename`). Install source and target both live under the same `$DSH_HOME`, so a plain rename is what actually runs; the fallback stays for unusually mounted homes and is documented rather than claimed as tested.

## Targeted fixtures

The built-in fixture measures a generic, deliberately desktop-first plugin panel. A pack aimed at one specific plugin can ship `packs/<id>/fixture.html` with that plugin's own DOM; `check-pack` then runs every round (baseline, pack, opt-out, desktop zero-regression) against it instead. Without the file the built-in fixture is used and the report says which one ran — human output prints `fixture：内置（回退内置 fixture）` and `--json` carries `fixture.kind`.

```bash
node tools/check-pack.mjs docs/examples/fixture-pack --desktop   # runnable example
```

The contract — allowed markup (DOM + inline styles only, no scripts/event handlers/external or `data:` references, ≤ 256 KB), the required shell/panel hooks, how `target` / `usesHostMarkers` / `evidence` must describe the fixture — is in [`docs/定向-fixture.md`](docs/定向-fixture.md). `docs/examples/fixture-pack/` is a runnable example, not a real pack: it lives outside `packs/`, is not in `catalog.json`, and therefore reports one harmless catalog warning.

## Opt out

```html
<html data-dsh-adapt="off">
```

Each pack stops applying entirely — panel spacing returns to its own values, shell rows return to the shell's sizes. This is checked by the harness, not asserted in prose.

**Careful on 0.8.1:** the host's own panel floor uses the same attribute as its gate (`:not([data-dsh-adapt="off"])` in `lib/mobile-layout.js:507`), so `off` **also disables the host floor** — the result can be worse than having no pack at all (measured in t12: Context Insights min 44 → 19.8px, `<44` 0 → 115). To disable a pack but keep the host floor, uninstall/disable the extension instead of setting this attribute.

## What has been verified

| | state |
| --- | --- |
| Fixture measurement: 390×844 coarse pointer, 1280×800 fine pointer zero-regression, opt-out | ✅ every pack (`node tools/check-pack.mjs`) |
| Fixture measurement on Windows 11 + Chromium (`node tools/check-pack.mjs --desktop`) | ✅ every pack (2026-10-31, earlier suite: 87 passed / 0 failed / 8 skipped; the suite changed since — CI on `windows-latest` runs the current one) |
| Real runtime on **dsh-mobile 0.8.0** | ✅ measured on the real gateway (390×844, coarse pointer, Plugins panel) — see `实测-0.8.0-20261031.md` in the workspace |
| Real runtime on **0.8.1 (contains #319)** | ⏳ shipped 2026-11-01; our gate (`:not([data-dsh-panel])`) backs the height floor and root-width clamp off once the host writes the marker — verified by `check-pack` host-probe with the host's own 0.8.1 rules injected, **not re-measured through a real 0.8.1 install**. This box now runs 0.8.1; the device run below still dates from the 0.7.1 app |
| Real runtime on **0.7.1** | ✅ historically (2026-10-31 earlier run); the 122px / 36→44px numbers were the same as 0.8.0 |
| Physical device | ✅ Android App measured (2026-11-01, Redmi K90 Max / Android 17 / dsh-mobile App 0.7.1): with `core-panel` installed (or with the full set) the slot reaches 141/44/0 where the no-pack baseline is 141/14/141 (`dshmarket-mobile` alone only fixes the market root); real `env(safe-area-inset-*)` is 0 because this App is **not** edge-to-edge; the soft keyboard shrinks the viewport 786→472. See [`docs/真机验证.md`](docs/真机验证.md). iOS, thumb-reach feel and edge-to-edge apps remain unverified |

### Two release lines: 0.8.0 vs main (#319)

`dsh-mobile` merged #319 on 2026-10-31 (`6c50b13`), after v0.8.0 was published (2026-10-30), and shipped it in **v0.8.1** (2026-11-01). So there are two host lines — and our packs have to behave on both:

| | release 0.8.0 | main after #319 |
| --- | --- | --- |
| host writes `data-dsh-panel` | **no** (grep: 0 hits) | yes, on `.dshm-main` |
| 44px hit floor for plugin panel controls | **no** (94/94 controls < 44px measured) | yes, host-provided |
| panel root width clamp | no | yes |
| icon-only button `min-width` | no | **yes** (0.8.1 floors both width and height) |
| bottom safe area on panel pages | no | **no** |

`core-panel` therefore gates its height floor and width clamp on `.dshm-main:not([data-dsh-panel])`: on 0.8.0 it is the only source, and on 0.8.1 (which owns that attribute) it steps aside instead of duplicating (and never writes the host's attribute — it keeps its own `data-dshm-adapt-panel`). Its `min-width:44` rule stays as the 0.8.0 fallback; 0.8.1 provides the same value, so on 0.8.1 it is a same-value safety net rather than a unique contribution. `check-pack` proves the gate with the host's own 0.8.1 rules injected (`runtime.hostGate.*`).

That is why the packs stay `experimental` rather than `candidate`. Measuring is a separate problem, and there is a tool for it: [`dsh-ui-lab`](https://github.com/LUgABeEEE/dsh-ui-lab) opens a DSH surface at real device proportions, captures a panel, and gates a matrix run on a pixel diff.

## Experiments

[`experiments/`](experiments/) holds adaptations that do **not** fit the pack contract (the
capability table or `check-pack`'s assertion groups) and are therefore not in `catalog.json`.
They are opt-in, default off, and carry their own lab evidence.

- [`experiments/tablet-wide/`](experiments/tablet-wide/): a wide-screen experiment borrowing
  dsh-go's *design* (persistent sidebar, centred content column, floating composer pill) —
  720px conversation column + 720px composer at `≥1100px` on a coarse pointer, hard-guarded by
  `.dshm-shell` (mobile-dedicated only); no dsh-go code or assets are copied.

## The dependency this cannot escape

These packs name dsh-mobile's own class names — `.dshm-shell`, `.dshm-main`, `.dshm-mainContent`, `.dshm-drawer`, `.dshm-panelNav`, `[data-slot="sidebar"]`. dsh-mobile does not promise to keep them, and its documentation explicitly rules out maintaining a general override table keyed on third-party class names. `catalog.json` lists the markers each pack touches (the `usesHostMarkers` field) precisely so a break is traceable to a pack, but a redesign can still break them.

The durable fix is a contract on the host side: stable attributes for panel state, for a plugin's own chrome, and for opting out. Until that exists, this repository is a compatibility layer that is expected to need maintenance — not something the dsh-mobile maintainers ship or support.

## Contributing

A new pack starts from [`packs/_template/`](packs/_template/) and has to pass `node tools/check-pack.mjs packs/<id>`. The rules — which capabilities may be claimed, how a pack must be scoped, what opt-out means, what a pack may not touch — are in [`docs/收录标准.md`](docs/收录标准.md) (Chinese; the check harness is the executable version of it).

[`docs/phone-instance.md`](docs/phone-instance.md) describes how to drive the real mobile page headlessly, which is how a pack gets verified beyond the fixture.

## Releasing

Push a tag that matches `package.json` and [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
validates the catalog, then publishes with npm provenance.

```bash
npm version patch --no-git-tag-version
git commit -am "chore: 0.1.1"
git tag v0.1.1 && git push origin main v0.1.1
```

The job needs the repository secret `NPM_TOKEN` (a granular token with "Read and
write" publish permission for `dsh-adapt-packs`). `workflow_dispatch` defaults to
`npm publish --dry-run`.

## License

MIT — see [LICENSE](LICENSE).
