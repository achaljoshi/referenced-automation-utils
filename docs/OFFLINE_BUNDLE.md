# Offline bundle: the packages and the repos as files

For a machine that can reach neither GitHub nor a registry that has these packages yet (for example an AWS WorkSpace that reaches only the organisation's npm registry). You build the bundle once on a machine that can, copy the folder over, and run everything from it. When the registry is ready you upload the same package files to it and the bundle is no longer needed.

## What is in the bundle

```
offline-bundle/
  packages/   automation-referenced-automation-<name>-<version>.tgz     utils, api, ui, sap, sas
  repos/      referenced-automation-<name>.tar.gz                       utils, api, ui, sap, sas, ui-api
  SHA256SUMS.txt                                                        a checksum for every file above
  README.md                                                             this page
```

- **`packages/`** are the packages the other repos install by version (`@automation/referenced-automation-utils` and the rest). They are the exact files `npm publish` uploads. `ui-api` is not a package: it only uses the others.
- **`repos/`** are the repos themselves (source, tests, docs, scripts) as they were committed, without `node_modules`.
- The bundle holds the committed state of each repo only. Anything uncommitted is not in it.

## Use it on the Windows machine (PowerShell)

1. **Copy the whole `offline-bundle` folder** to the machine and check the files arrived intact (every line should print `OK`; the checksum file uses forward slashes, so run it from inside the folder):

   ```powershell
   cd C:\work\offline-bundle
   Get-Content SHA256SUMS.txt | ForEach-Object {
     $hash, $file = $_ -split '\s+', 2
     $actual = (Get-FileHash -Algorithm SHA256 $file.Trim()).Hash.ToLower()
     "$(if ($actual -eq $hash) { 'OK  ' } else { 'FAIL' }) $file"
   }
   ```

2. **Unpack the repos side by side** in one working folder, and put the packages in a `shared-packages` folder next to them. The repos must be siblings, and the folder must be called `shared-packages`: the `--local` setup looks for `..\shared-packages` from inside a repo.

   ```powershell
   mkdir C:\work\automation
   cd C:\work\automation
   Get-ChildItem C:\work\offline-bundle\repos\*.tar.gz | ForEach-Object { tar -xzf $_.FullName }
   mkdir shared-packages
   Copy-Item C:\work\offline-bundle\packages\*.tgz shared-packages\
   ```

   `tar` is part of Windows 10 and 11. You now have `referenced-automation-utils`, `-api`, `-ui`, `-sap`, `-sas`, `-ui-api` and `shared-packages` in `C:\work\automation`.

3. **Install a repo from the packages** (the `.\` in front is needed in PowerShell):

   ```powershell
   cd C:\work\automation\referenced-automation-ui
   .\scripts\setup.bat --local
   ```

   `--local` installs the `@automation/*` packages from `..\shared-packages` (the file whose version matches the repo next to it) and everything else from the npm registry npm is configured with. Nothing in `package.json` or the lockfile changes. Do the same in any repo you want to run.

4. **Run the tests**, for example `npm test`. If the browser download is blocked on your network, use the installed Edge instead: `$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"; $env:BROWSER = "msedge"` before step 3 (see the README, "Windows first run").

`npm ci` removes what it is not told about, so after an `npm ci` run `.\scripts\setup.bat --local` again.

## Later: upload the packages to the registry (JFrog)

The files in `packages/` are what the registry stores, so nothing has to be rebuilt:

```powershell
$env:NPM_REGISTRY_URL = "<your registry URL>"
npm publish packages\automation-referenced-automation-utils-1.0.1.tgz --registry $env:NPM_REGISTRY_URL
```

Publish in this order, each file once: `utils`, then `api` and `ui`, then `sap`, then `sas`. A version can be published only once. Your npm must already be allowed to publish to that registry; these scripts never log in for you (README, "Publishing a package to the registry"). Without the npm route, the registry's web page can deploy a `.tgz` into the npm repository (**Deploy**); check with your platform team how your repository is set up.

Afterwards a repo installs from the registry with `.\scripts\setup.bat` (no `--local`) and the `shared-packages` folder is not needed. Check with `npm view @automation/referenced-automation-utils versions --registry $env:NPM_REGISTRY_URL`.

## Make a new bundle (macOS, Linux or Git Bash)

Commit your work in every repo first, with the six repos checked out next to `referenced-automation-utils`:

```bash
./scripts/create-offline-bundle.sh                  # writes ../offline-bundle
./scripts/create-offline-bundle.sh ~/Desktop/bundle # or into a folder of your choice
```

The script refuses to run when a repo has uncommitted changes. It archives each repo's committed state into a clean temporary folder, builds the five packages there in dependency order with `create-package.sh --local` (so your working folders and your VS Code are untouched), copies the results to `packages/` and `repos/`, and writes `SHA256SUMS.txt` and this page as `README.md`. It needs the npm registry npm is configured with, once, for the packages' own third-party dependencies.

A new version of a package needs a new version number first (`npm version patch --no-git-tag-version` in that repo, a `CHANGELOG.md` line, a commit, and the repos that depend on it moving to it in their `package.json`); a version that is already in the registry cannot be published again. The README of each repo describes this under "Upgrading a package".
