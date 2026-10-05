# Release

Garuda is published to npm as `@garuda-agent/garuda` (the npm organization `garuda-agent`). The
command is `garuda`. Homebrew installs the same npm package through the tap
`madhu-sv/homebrew-garuda`.

## The package

- `package.json` `files` puts only `dist/**/*.js`, `LICENSE`, `NOTICE`, `README.md` and `SECURITY.md`
  in the package: no source maps, tests or the standalone bundle.
- The `prepack` script runs `pnpm build`, so `npm pack` and `npm publish` always use a fresh build.
- To see what goes in the package: `npm pack --dry-run`.

## A release

1. Set the version in `package.json` and `src/version.ts` (a test checks that they match), add the
   release notes, and merge to `main`.
2. Tag the merge commit and push the tag:

   ```sh
   git tag -a v0.14.1 -m "Garuda 0.14.1" && git push origin v0.14.1
   ```

3. The workflow `.github/workflows/release.yml` runs: it checks that the tag matches the version,
   runs `pnpm check`, and publishes with npm trusted publishing. The repository holds no npm token.
   npm adds a provenance statement that links the package to the workflow run.
4. Update the Homebrew formula (below).

## The first publish (done for 0.14.1)

npm can configure a trusted publisher only for a package that exists. So the package name was taken
with a placeholder, published by hand, and every real version comes from the release workflow with
provenance. For a new package, do the same:

1. Log in and check the organization:

   ```sh
   npm login                      # opens the browser; use the account that owns garuda-agent
   npm whoami
   npm org ls garuda-agent        # you are listed as owner
   ```

2. Publish a placeholder from an empty folder (only a `package.json`):

   ```sh
   mkdir /tmp/garuda-placeholder && cd /tmp/garuda-placeholder
   printf '{\n  "name": "@garuda-agent/garuda",\n  "version": "0.0.1",\n  "description": "Placeholder. Install 0.14.1 or later.",\n  "license": "Apache-2.0"\n}\n' > package.json
   npm publish --access public    # npm asks for your 2FA code
   ```

3. On npmjs.com, open the package, **Settings**, **Trusted Publisher**, choose GitHub Actions, and
   enter: organization or user `madhu-sv`, repository `garuda`, workflow filename `release.yml`
   (the name only), environment `npm`. Under **Allowed actions**, allow direct publish: a new
   trusted publisher may only stage a version, and the workflow then fails with
   `403 OIDC permission denied for this action`.
4. Set **Publishing access** to "Require two-factor authentication and disallow tokens".
5. On GitHub, **Settings**, **Environments**, make the environment `npm`: a deployment rule for tags
   `v*`, and optionally yourself as a required reviewer (each release then waits for your approval).
6. Push the version tag. The workflow publishes it. If it fails, fix the setting and use **Re-run
   failed jobs**; the tag stays.
7. Deprecate the placeholder:

   ```sh
   npm deprecate @garuda-agent/garuda@0.0.1 "Placeholder. Use 0.14.1 or later."
   ```

The workflow skips a version that is already on npm, so a version published by hand is not an
error.

## Homebrew

The tap is the GitHub repository `madhu-sv/homebrew-garuda`. Its file `Formula/garuda.rb` is a copy
of `packaging/homebrew/garuda.rb` with the release's tarball hash. For each release:

```sh
v=0.14.1
url="https://registry.npmjs.org/@garuda-agent/garuda/-/garuda-$v.tgz"
curl -sSfL "$url" | shasum -a 256
```

Put the version in `url` and the hash in `sha256`, commit to the tap, then check it:

```sh
brew update && brew reinstall madhu-sv/garuda/garuda && brew test madhu-sv/garuda/garuda
brew audit --strict madhu-sv/garuda/garuda
```

Users install with `brew install madhu-sv/garuda/garuda`. homebrew-core needs a more widely used
project, so the tap is the way for now.
