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

## The first publish (once, by hand)

npm can configure a trusted publisher only for a package that exists. So the first version is
published from your computer:

```sh
npm login                      # opens the browser; use the account that owns garuda-agent
npm whoami
npm org ls garuda-agent        # you are listed as owner
git switch main && git pull && pnpm install && pnpm check
npm publish --access public    # prepack builds; npm asks for your 2FA code
```

Then, on npmjs.com, open the package, **Settings**, **Trusted publishing**, choose GitHub Actions,
and enter: organization or user `madhu-sv`, repository `garuda`, workflow file `release.yml`,
environment `npm`. After that, set **Publishing access** to "Require two-factor authentication and
disallow tokens". Later versions come only from the release workflow.

Then push the tag of that version. The release workflow sees that the version is already on npm
and skips the publish step.

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
