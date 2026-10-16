# Supplementary distribution licenses

The installed `@react-three/fiber@9.8.2` npm payload lacks its upstream license file. The CLI distribution includes the complete MIT text from the corresponding upstream tag, pinned to Git object `d74622ea8ed717f7212d7e19d65ff3e325508389`:

- [Upstream LICENSE](https://github.com/pmndrs/react-three-fiber/blob/d74622ea8ed717f7212d7e19d65ff3e325508389/LICENSE)
- Local copy: `react-three-fiber-9.8.2-LICENSE`.

The packager uses this exception only for that exact package/version; a version change requires review of the corresponding license. All other third-party license texts come directly from the locked installed npm payloads. Building the distribution performs no network request.
