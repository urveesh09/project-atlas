import { useEffect, useRef } from 'react';
import type { CityBuilding, CityData, CityLens } from '@atlas/layout';
import { CityRenderer, type CityGhost } from './renderer';
import type { CityHandle } from './types';
import type { OverlayResult } from './overlay';
import type {} from './probe';

export default function ThreeCity(props: {
  /** One renderer per layout: frames of the same artifact reuse it (camera kept). */
  layoutKey: string;
  ghosts: readonly CityGhost[];
  city: CityData;
  lens: CityLens;
  selected: ReadonlySet<string>;
  filter(b: CityBuilding): boolean;
  overlay: OverlayResult;
  focusNonce: number;
  lowQuality: boolean;
  select(id: string): void;
  hover(id: string | null): void;
  fail(reason: string): void;
  register(handle: CityHandle | null): void;
}) {
  const host = useRef<HTMLDivElement>(null),
    renderer = useRef<CityRenderer | null>(null),
    latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let view: CityRenderer;
    try {
      view = new CityRenderer(
        host.current!,
        latest.current.city,
        {
          select: (id) => latest.current.select(id),
          hover: (id) => latest.current.hover(id),
          fail: (reason) => latest.current.fail(reason),
        },
        props.lowQuality,
      );
    } catch {
      latest.current.fail('3D graphics are unavailable. The same city is available as a map and table.');
      return;
    }
    renderer.current = view;
    props.register({
      reset: () => view.reset(),
      zoom: (f) => view.zoom(f),
      north: () => view.north(),
      focus: (ids) => view.focus(ids),
      exportPng: () => view.exportPng(),
      cameraState: () => view.cameraState(),
    });
    if (new URLSearchParams(location.search).get('atlasBenchmark') === '1') window.__atlasCity = view;
    return () => {
      if (window.__atlasCity === view) delete window.__atlasCity;
      view.dispose();
      renderer.current = null;
      latest.current.register(null);
    };
  }, [props.layoutKey, props.lowQuality, props.register]);
  useEffect(() => {
    try {
      renderer.current?.setCity(props.city);
    } catch {
      latest.current.fail('This snapshot could not be drawn in 3D. The map and table show it.');
    }
  }, [props.city, props.layoutKey, props.lowQuality]);
  useEffect(() => {
    renderer.current?.setGhosts(props.ghosts);
  }, [props.ghosts, props.layoutKey, props.lowQuality]);
  useEffect(() => {
    renderer.current?.applyStyle(props.lens, props.selected, props.filter);
  }, [props.city, props.lens, props.selected, props.filter, props.lowQuality]);
  useEffect(() => {
    renderer.current?.setOverlay(props.overlay);
  }, [props.overlay, props.city, props.lowQuality]);
  useEffect(() => {
    if (props.focusNonce) renderer.current?.focus(props.selected);
  }, [props.focusNonce]);
  return (
    <div
      ref={host}
      className="city-surface"
      data-city-renderer="3d"
      aria-label="Miniature city. Select files through the repository tree, search or file table."
      role="img"
    />
  );
}
