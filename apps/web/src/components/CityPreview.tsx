import preview from '../assets/city-preview.webp';

/**
 * What an analysis becomes, shown before one is opened (ADR-058). The image is the viewer's
 * own render of the bundled demo artifact (vuejs/core), not a mock-up.
 */
export function CityPreview() {
  return (
    <figure className="gate-figure">
      <img src={preview} width={1120} height={700} decoding="async" alt="The vuejs/core repository drawn as an ATLAS city: one building per file, grouped into coloured package districts on an island." />
      <figcaption>Example: vuejs/core as a city. Each building is a file; height shows code lines and colour shows the package.</figcaption>
    </figure>
  );
}
