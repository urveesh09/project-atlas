# Supplementary distribution licenses

Two installed npm payloads lack their upstream license file. The CLI distribution includes
the complete MIT text for each from the upstream repository, pinned to a Git object:

- `@react-three/fiber@9.8.2`: the corresponding upstream tag,
  [LICENSE at `d74622ea8ed717f7212d7e19d65ff3e325508389`](https://github.com/pmndrs/react-three-fiber/blob/d74622ea8ed717f7212d7e19d65ff3e325508389/LICENSE).
  Local copy: `react-three-fiber-9.8.2-LICENSE`.
- `react-remove-scroll-bar@2.3.8` (a dependency of `@radix-ui/react-select`, ADR-106). Its
  `package.json` declares MIT (author Anton Korzunov). The repository had no license file
  when 2.3.8 was published (2024-12-15; npm's `gitHead` is not on GitHub); the author added
  the MIT text in
  [`7301c160fda44cb8cf2b9fdfde61efad35736196`](https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE)
  (blob `7c08c3990396ecefd90f99ff5d9a34f26f5b5616`, which the local copy matches).
  Local copy: `react-remove-scroll-bar-2.3.8-LICENSE`.

The packager uses these exceptions only for those exact packages and versions; a version
change requires review of the corresponding license. All other third-party license texts
come directly from the locked installed npm payloads. Building the distribution performs no
network request.
