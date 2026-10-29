# ADR-0002: Published image and its versions

- Status: accepted
- Date: 2026-10-29
- Decided in [How is the Buzzdrop image published and versioned?](https://github.com/buzzdrop/buzzdrop/issues/376), part of [Wayfinder: 1-click trial deploys and a compose path for self-hosters](https://github.com/buzzdrop/buzzdrop/issues/373).

Self-hosters run a published image, `ghcr.io/buzzdrop/buzzdrop` (public, GHCR only), for amd64 and arm64. Versions are SemVer and stay on `0.x` until Buzzdrop calls itself production. While on `0.x`, a minor bump may break things and a patch never does. A version is cut by hand: the maintainer pushes a `vX.Y.Z` tag and publishes a GitHub Release whose notes always have a "Breaking changes" section. The image's tags are a public contract that deploy buttons and compose files depend on, so they are recorded here.

## Tags

| Trigger | Tags |
|---|---|
| tag `v0.4.2` | `0.4.2`, `0.4`, `latest` |
| merge to `main` | `main`, `sha-<7 chars>` |

`latest` only ever means the newest version, never `main`. There is no moving `0` tag: under `0.x` it would cross breaking changes. `1` arrives with `1.0.0`. An image is pushed only after CI passes for its commit. Old `main`/`sha-*` images are kept, not pruned.

## Who pins what

- **"Try it" buttons** use `latest`. A trial is throwaway and may lose its data on a restart anyway, and pinning would mean a config PR on every version.
- **The "Run it" compose file** pins an exact version, `ghcr.io/buzzdrop/buzzdrop:${BUZZDROP_VERSION:-<x.y.z>}`. A long-term instance holds real drops, and its owner should read the notes before crossing a breaking minor. Cutting a version bumps the default.

## Consequences

- The image carries its version as `BUZZDROP_VERSION` (`main+<sha>` on `main` builds) and as OCI labels (`org.opencontainers.image.version`, `.revision`, `.source`). Showing it in the app is a separate decision.
- Each image gets a GitHub build-provenance attestation (`gh attestation verify`). No cosign signature, no SBOM.
- The image workflow is separate from `release-cli.yml`. The CLI keeps its own `cli-*` tags and is not versioned with the app.
- The base image must have arm64 wheels for our dependencies. armv7 is not built.
