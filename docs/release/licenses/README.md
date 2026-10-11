# Supplementary distribution licenses

The installed `@react-three/fiber@9.8.1` npm payload lacks its upstream license file. The CLI distribution includes the complete MIT text from the corresponding upstream tag, pinned to Git object `53ec672ac4a7189711766b87ece18889abbb32d4`:

- [Upstream LICENSE](https://github.com/pmndrs/react-three-fiber/blob/53ec672ac4a7189711766b87ece18889abbb32d4/LICENSE)
- Local copy: `react-three-fiber-9.8.1-LICENSE`.

The packager uses this exception only for that exact package/version; a version change requires review of the corresponding license. All other third-party license texts come directly from the locked installed npm payloads. Building the distribution performs no network request.
