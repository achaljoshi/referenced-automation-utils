# Setting up all six repos on a Windows machine, step by step

One page that takes a clean Windows machine to six working repos: what to install, which commands to run in which order, what you should see, how to check each repo, and what to do when a step fails. Every command is for **PowerShell** (Windows PowerShell 5.1 or PowerShell 7, also the terminal inside VS Code), run from the folder named above it. They are on separate lines on purpose: Windows PowerShell 5.1 has no `&&`.

The repos are not all installed the same way. Until the shared packages are published to your npm registry, five of them must be installed with `--local`. This page uses `--local` throughout and says at the end how to switch.

## 1. What you are setting up

| Repo | What it is | Needs these checked out next to it |
|---|---|---|
| `referenced-automation-utils` | Shared utilities (config, logging, crypto, files, DB, SMTP, SFTP). No browser. | nothing |
| `referenced-automation-api` | API testing framework and API mocks. | utils |
| `referenced-automation-ui` | Browser UI testing framework. | utils, api |
| `referenced-automation-sap` | SAP GUI and Fiori testing. | utils, ui |
| `referenced-automation-sas` | SAS testing. | utils, api, ui |
| `referenced-automation-ui-api` | Tests that mix UI and API (a consumer, not a package). | utils, api, ui, sap |

The tests in every repo run against stand-ins and local test servers that ship with the repo, so they pass without any real SAP, SAS or application system. Real systems are optional and covered in [step 7](#7-connect-to-a-real-system-optional).

## 2. Before you start

| You need | Check with | Notes |
|---|---|---|
| Node.js 18 or newer | `node --version` | 22 or newer is best. |
| npm | `npm --version` | Comes with Node. |
| The npm registry your organisation uses | `npm config get registry` | Must print that registry, not an unrelated one. Third-party packages (Playwright, TypeScript, and so on) are downloaded from it during setup. |
| Git | `git --version` | To clone the repos. |
| Microsoft Edge or Google Chrome | already on the machine | Used instead of Playwright's own browsers when their download is blocked. |
| VS Code (optional) | `code --version` | For step navigation in `.feature` files. |

Plan for 2 to 3 GB of free disk space, and a few minutes per repo. Keep the working folder path short, for example `C:\work\automation`, so Windows does not hit its path length limit.

## 3. Set the network variables first (only if your network needs them)

Setup begins with a TLS check (`scripts\check-tls.js`) of the npm registry and of the host Playwright downloads browsers from. If either is a problem it stops and prints the exact fix. These are the two usual ones; set them in the same PowerShell window you will run setup in.

**A company proxy re-signs HTTPS** (setup reports `certificate NOT trusted`): give Node the company root certificate (a `.pem` file from IT):

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\path\to\company-root-ca.pem"
```

On Node 22.15 or newer you can let Node read the Windows certificate store instead:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
```

Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`: it turns certificate checking off for every Node program in that window, npm included.

**Playwright's browser download is blocked** (only the browsers, the registry is fine): use the Edge that is installed:

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
$env:BROWSER = "msedge"
```

Use `chrome` instead of `msedge` for Google Chrome. A `$env:` value stays set for the whole PowerShell window; undo it with `Remove-Item Env:BROWSER` and `Remove-Item Env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`. To keep a value for every new window, add it to your Windows user environment variables.

If your npm is not yet pointed at the registry, set the registry for this window with `$env:NPM_REGISTRY_URL = "<your registry URL>"`; setup then runs `npm config set registry` with it. Your npm must already be allowed to read from that registry; these scripts never log in for you.

## 4. Clone the six repos side by side

They must be siblings in one parent folder: `--local` looks for them at `..\referenced-automation-<name>`.

```powershell
mkdir C:\work\automation
cd C:\work\automation
git clone https://github.com/achaljoshi/referenced-automation-utils.git
git clone https://github.com/achaljoshi/referenced-automation-api.git
git clone https://github.com/achaljoshi/referenced-automation-ui.git
git clone https://github.com/achaljoshi/referenced-automation-sap.git
git clone https://github.com/achaljoshi/referenced-automation-sas.git
git clone https://github.com/achaljoshi/referenced-automation-ui-api.git
dir
```

You should see the six `referenced-automation-*` folders. Sign in to GitHub the way you normally do if a clone asks. The `.bat` files get Windows line endings from the clone automatically (`.gitattributes`); do not copy them in from another machine by hand.

If the machine cannot reach GitHub, unpack the repos from the [offline bundle](OFFLINE_BUNDLE.md) into the same folder instead of cloning; every other step stays the same.

## 5. Run setup in each repo

Run these in order. Plain `.\scripts\setup.bat` for utils, `.\scripts\setup.bat --local` for the other five. The `.\` in front is required in PowerShell.

```powershell
cd C:\work\automation\referenced-automation-utils
.\scripts\setup.bat

cd C:\work\automation\referenced-automation-api
.\scripts\setup.bat --local

cd C:\work\automation\referenced-automation-ui
.\scripts\setup.bat --local

cd C:\work\automation\referenced-automation-sap
.\scripts\setup.bat --local

cd C:\work\automation\referenced-automation-sas
.\scripts\setup.bat --local

cd C:\work\automation\referenced-automation-ui-api
.\scripts\setup.bat --local
```

What each run does, in order:

1. Checks that Node trusts the HTTPS certificates of the registry and, unless you skipped the browser download, of the Playwright host.
2. With `--local`: makes sure each `@automation/*` package this repo depends on exists as a `.tgz` in `C:\work\automation\shared-packages`, building it from its sibling clone when it is missing, and installs those files. `package.json` and the lockfile do not change. Without `--local` (utils only): `npm ci`.
3. Downloads the Playwright browsers, or skips that when `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
4. Installs the VS Code extensions the repo recommends (see [step 8](#8-vs-code-step-navigation-in-feature-files)). A failure here never stops setup; add `--no-extensions` to skip it.

It ends with `Setup complete. Try: npm test`. The first `--local` run in `sas` or `ui-api` is the slow one because it builds the packages it needs; later runs reuse them from `shared-packages` as long as the version matches the sibling clone.

Do not run `npm ci` by hand in a repo you installed with `--local`: it removes the local packages. If you did, run `.\scripts\setup.bat --local` again.

## 6. Check that each repo works

Run from the root of each repo. Each command ends with the number of tests that passed; a few skipped tests are normal (they need a real system), failures are not.

```powershell
cd C:\work\automation\referenced-automation-utils
npm test

cd C:\work\automation\referenced-automation-api
npm test

cd C:\work\automation\referenced-automation-ui
npm test

cd C:\work\automation\referenced-automation-sap
npm test

cd C:\work\automation\referenced-automation-sas
npm run test:ci

cd C:\work\automation\referenced-automation-ui-api
npm test
```

- `npm test` first generates the test files from the `.feature` files (`bddgen`), then runs every test.
- In `sas`, `npm run test:ci` also fails when fewer than 600 tests ran, which catches a broken setup that would otherwise "pass" by running nothing.
- Run `npm run lint` in a repo to check the code style.
- If a browser test fails to launch a browser, you skipped the download and have not set `BROWSER`; see [step 3](#3-set-the-network-variables-first-only-if-your-network-needs-them).

## 7. Connect to a real system (optional)

Skip this unless you want the tests to talk to a real application, SAP or SAS system.

- Every repo documents every setting it reads in its `.env.example` (what it is, the allowed values, whether it is a secret, where to find the value).
- Settings are loaded in this order, later wins: `.env`, then `.env.<ENV>`, then `.env.<ENV>.local`, then variables set in the shell. `ENV` defaults to `qa`; choose another with `$env:ENV = "dev"`.
- `.env.<ENV>` is committed and holds **no secrets**. Passwords and tokens go in `.env.<ENV>.local` (git-ignored; the template is `.env.local.example` or `.env.qa.local.example`, depending on the repo). Never commit that file and never paste a secret into a chat or an issue.
- A value with `#`, `$` or spaces must be in double quotes, or it is silently cut: `SAP_PASSWORD="my#pass word"`.
- In `sas`, use your own personal login only. The repo has a lockout guard so a wrong password does not lock an account; leave that guard in place.
- Real-system tests are separate commands and are never part of `npm test`: `npm run test:real-smoke`, `npm run test:real-samples` and `npm run test:conformance` in `sas`, and `npm run test:sapgui` in `sap` (needs SAP GUI installed).

## 8. VS Code: step navigation in feature files

Open each repo as its own folder (File, then Open Folder, then the repo folder, not the parent). Setup installs the official Cucumber extension (`cucumberopen.cucumber-official`) when the `code` command is available; each repo's `.vscode/settings.json` already points it at that repo's step files. Ctrl-click on a step in a `.feature` file then opens its step definition.

If setup could not install the extensions, in each repo run:

```powershell
npm run install:extensions
```

Without the `code` command on PATH, install `cucumberopen.cucumber-official` and the other extensions listed in `.vscode/extensions.json` from the Extensions view (Ctrl+Shift+X). Where the Visual Studio Marketplace is blocked, download the `.vsix` file on another machine and install it with `code --install-extension <file>.vsix`. The shared steps live in `src\bdd` (ui, api, sas), `src\gui\steps.ts` (sap) and in `node_modules\@automation\*\dist`; if a step does not navigate, reload the window (Ctrl+Shift+P, then `Developer: Reload Window`) once after setup finished.

## 9. Day-to-day commands

| What | Command |
|---|---|
| Run everything | `npm test` |
| Only smoke tests | `npm run test:smoke` (ui, sap, sas, ui-api) |
| Only regression tests | `npm run test:regression` (ui, sap, sas, ui-api) |
| Only the `.feature` (BDD) tests | `npm run test:bdd` |
| One test file (forward slashes) | `npx playwright test tests/dialogs.spec.ts` |
| One test by part of its title | `npx playwright test -g "a prompt is answered"` |
| Watch it run | `npx playwright test --headed` |
| A browser that is already installed | `$env:BROWSER = "msedge"; npx playwright test` |
| Open the last HTML report | `npx playwright show-report` |

`npx playwright test` does not run `bddgen`: after you change a `.feature` file or a step, run `npm test` (or `npx bddgen`) first. Pick test files with forward slashes; a backslash path finds nothing on Windows.

## 10. When the packages are in the registry

Once an administrator has published the packages (see the README, "Publishing a package to the registry"; utils first, then api and ui, then sap, then sas), the clones of the other repos are no longer needed to install and the `--local` flag can go:

```powershell
cd C:\work\automation\referenced-automation-ui
.\scripts\setup.bat
```

That runs `npm ci` and gets each `@automation/*` package by the version in `package.json`. Check what the registry has with `npm view @automation/referenced-automation-utils versions`. Then `shared-packages` can be deleted.

## 11. When a step fails

| What you see | Why | Fix |
|---|---|---|
| `scripts\setup.bat` is not recognized, or PowerShell says the term is not recognized | PowerShell does not run a script from the current folder without a path. | Write `.\scripts\setup.bat`. |
| `certificate NOT trusted`, `self-signed certificate in certificate chain`, `unable to get local issuer certificate` | A company proxy re-signs HTTPS and Node does not know its root certificate. | [Step 3](#3-set-the-network-variables-first-only-if-your-network-needs-them): `NODE_EXTRA_CA_CERTS`, then run setup again. Not `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `could not connect` in the TLS check | A proxy or VPN is needed to reach that host. Not a certificate problem. | Setup carries on; if the install itself then fails, fix the network or proxy first. |
| The Playwright browser download fails, or hangs | The CDN `cdn.playwright.dev` is blocked. | Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and `BROWSER=msedge` ([step 3](#3-set-the-network-variables-first-only-if-your-network-needs-them)), run setup again. |
| `npm ci failed ... @automation/...` | You ran setup without `--local` and that package version is not in the registry yet. | `.\scripts\setup.bat --local`. |
| `ERROR: referenced-automation-<name> is not packaged and not checked out` | A repo `--local` needs is not cloned next to this one. | Clone it into the same parent folder ([step 4](#4-clone-the-six-repos-side-by-side)). |
| `Cannot find module '@automation/...'` after `npm ci` or `npm install` | `npm ci` (or a plain `npm install`) removed the locally installed packages. | `.\scripts\setup.bat --local` again. |
| `npm error 404` or `E401` for a package | The registry does not have it, or npm is not allowed to read it. | Check `npm config get registry`; ask whoever runs the registry. These scripts do not sign in for you. |
| Setup prints `the code command was not found` | VS Code's `bin` folder is not on PATH. | Harmless. Install the extensions by hand ([step 8](#8-vs-code-step-navigation-in-feature-files)). |
| `No tests found` when you run one file | A backslash in the path. | Use forward slashes: `tests/dialogs.spec.ts`. |
| A new `.feature` file does nothing | `npx playwright test` skips `bddgen`. | `npm test`, or `npx bddgen` first. |
| A setting "does not take" | A variable set in the shell wins over every `.env` file, and stays set for the whole window. | `Get-ChildItem Env:`, then `Remove-Item Env:NAME`. |
| A browser test cannot start a browser | The download was skipped and `BROWSER` is not set. | `$env:BROWSER = "msedge"`. |
| `ENAMETOOLONG` or "path too long" | The clone path is too long. | Clone closer to the drive root, or run `git config --global core.longpaths true` before cloning. |
| A `.bat` file fails strangely at its first lines | It was copied from another machine with Unix line endings. | Take the file from the Git clone, not a copy. |

If something else fails, send the repo you were in, the exact command, the whole output (or a photo of it), and the output of `node --version` and `npm config get registry`. Do not include passwords, tokens or the contents of any `.local` file.

## 12. Update later

```powershell
cd C:\work\automation
foreach ($repo in Get-ChildItem -Directory -Filter "referenced-automation-*") { git -C $repo.FullName pull }
```

That pulls every repo, then run `.\scripts\setup.bat --local` again in the repos whose dependencies changed. A new package version has a new file name, and setup picks the file whose version matches the sibling clone, so an older file left in `shared-packages` is never installed by mistake.
