# Releasing `@bloomscorp/imagine.js`

Publish this package **before** `@bloomscorp/ngx-imagine` and
`@bloomscorp/react-imagine`. Both wrappers declare it as a peer
(`^0.1.0`) and are built against it.

## How it works

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`, which:

1. checks that npm is new enough for trusted publishing (≥ 11.5.1)
2. runs `npm ci`, `lint`, `test`, `build` and `verify:package`
3. checks the tag equals `package.json`'s version
4. publishes with `npm publish --provenance --access public`; a prerelease
   (`0.2.0-rc.1`) goes to the `next` dist-tag, never `latest`; a version that is
   already on npm is skipped
5. creates the GitHub release

There is **no publish secret**. npm trusts the workflow through a trusted publisher
(OIDC). The GitHub release uses `GITHUB_TOKEN`, which Actions provides.

## One-time setup (owner)

1. Create the empty GitHub repository `bloomscorp/imagine.js`, then push:

   ```bash
   git remote add origin git@github.com:bloomscorp/imagine.js.git
   git push -u origin main
   ```

2. Publish the first version by hand. npm only lets you add a trusted publisher to
   a package that already exists. From a clean checkout of `main`:

   ```bash
   npm login
   npm ci && npm run lint && npm test && npm run build && npm run verify:package
   npm publish --access public
   ```

3. On npmjs.com, open the package → **Settings** → **Trusted publisher** →
   **GitHub Actions**, and enter exactly:

   | Field | Value |
   |---|---|
   | Organization or user | `bloomscorp` |
   | Repository | `imagine.js` |
   | Workflow filename | `release.yml` |
   | Environment | (empty) |

   Then, under **Publishing access**, choose "Require two-factor authentication and
   disallow tokens". From now on only the workflow can publish.

4. Tag the version you published by hand, so git and npm agree:

   ```bash
   git tag -a v0.1.0 -m "Release 0.1.0"
   git push origin v0.1.0
   ```

   The workflow sees `0.1.0` is already on npm, skips the publish and creates the
   GitHub release.

## Every release after that

From `main`, up to date, with a clean working tree:

```bash
npm version 0.2.0 --no-git-tag-version     # or 0.2.0-rc.1 for a prerelease
# write the CHANGELOG.md entry
npm ci && npm run lint && npm test && npm run build && npm run verify:package
git commit -am "chore: release v0.2.0"
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin main && git push origin v0.2.0
```

Then check:

```bash
npm view @bloomscorp/imagine.js version
```

`ETARGET` from `npm install` straight after a publish is the npm CDN catching up.
Wait a few minutes.

## The wrappers' peer range

The wrappers declare `"@bloomscorp/imagine.js": "^0.1.0"`. In 0.x a caret covers
patches only: `^0.1.0` means `>=0.1.0 <0.2.0`. So:

- a **patch** here (`0.1.1`) reaches every app without a wrapper release
- a **minor** here (`0.2.0`) needs a release of both wrappers with the range widened

## If something goes wrong

**E404 at the upload, after provenance was signed.** The trusted publisher does not
match: the organization, repository or workflow filename differ from GitHub's.
npm does not allow editing it; delete the entry, create it again, then **Re-run
failed jobs** on the same run. No new tag is needed, because nothing was published.

**EOTP.** npm wanted a one-time password, so it did not see a trusted publish. Same
cause as above, or npm older than 11.5.1.

**The workflow failed before publishing.** Nothing is public. Fix, commit, then move
the tag:

```bash
git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z
git tag -a vX.Y.Z -m "Release X.Y.Z" && git push origin main && git push origin vX.Y.Z
```

**A wrong version was published.** npm versions are immutable. Release the next patch.
