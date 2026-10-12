import { useEffect, useRef } from 'react';
import type { CityBuilding, CityData, CityLens } from '@atlas/layout';
import { CityRenderer, type CityGhost, type ViewHistory } from './renderer';
import type { CityHandle } from './types';
import type { OverlayResult } from './overlay';
import type { CityTheme } from './themes';
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
  theme: CityTheme;
  select(id: string): void;
  hover(id: string | null): void;
  fail(reason: string): void;
  register(handle: CityHandle | null): void;
  /** Whether earlier or later camera views exist, for Back and Forward. */
  views(state: ViewHistory): void;
}) {
  const host = useRef<HTMLDivElement>(null),
    renderer = useRef<CityRenderer | null>(null),
    // The view survives a style or detail switch, which rebuilds the renderer.
    lastView = useRef<{ key: string; camera: ReturnType<CityRenderer['cameraState']> } | null>(null),
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
          views: (state) => latest.current.views(state),
        },
        props.lowQuality,
        props.theme,
      );
    } catch {
      latest.current.fail('3D graphics are unavailable. The same city is available as a map and table.');
      return;
    }
    renderer.current = view;
    // A camera saved in the same layout survives a style or detail switch.
    const viewKey = props.layoutKey;
    if (lastView.current?.key === viewKey) view.restoreCamera(lastView.current.camera);
    props.register({
      reset: () => view.reset(true),
      zoom: (f) => view.zoom(f),
      north: () => view.north(),
      focus: (ids) => view.focus(ids),
      exportPng: () => view.exportPng(),
      cameraState: () => view.cameraState(),
      travel: (step) => view.travel(step),
    });
    if (new URLSearchParams(location.search).get('atlasBenchmark') === '1') window.__atlasCity = view;
    return () => {
      if (window.__atlasCity === view) delete window.__atlasCity;
      lastView.current = { key: viewKey, camera: view.cameraState() };
      view.dispose();
      latest.current.views({ back: false, forward: false });
      renderer.current = null;
      latest.current.register(null);
    };
  }, [props.layoutKey, props.lowQuality, props.theme, props.register]);
  useEffect(() => {
    try {
      renderer.current?.setCity(props.city);
    } catch {
      latest.current.fail('This snapshot could not be drawn in 3D. The map and table show it.');
    }
  }, [props.city, props.layoutKey, props.lowQuality, props.theme]);
  useEffect(() => {
    renderer.current?.setGhosts(props.ghosts);
  }, [props.ghosts, props.layoutKey, props.lowQuality, props.theme]);
  useEffect(() => {
    renderer.current?.applyStyle(props.lens, props.selected, props.filter);
  }, [props.city, props.lens, props.selected, props.filter, props.lowQuality, props.theme]);
  useEffect(() => {
    renderer.current?.setOverlay(props.overlay);
  }, [props.overlay, props.city, props.lowQuality, props.theme]);
  useEffect(() => {
    if (props.focusNonce) renderer.current?.focus(props.selected);
  }, [props.focusNonce]);
  // The city takes keys once clicked or tabbed to: drive with arrows or W A S D (ADR-045).
  return (
    <div
      ref={host}
      className="city-surface"
      data-city-renderer="3d"
      role="application"
      aria-roledescription="3D city"
      aria-label="Miniature city. Move with the arrow keys or W A S D, turn with Q and E, tilt with Shift and the up or down arrow, zoom with plus and minus. Select files through the repository tree, search or file table."
      tabIndex={0}
      onPointerDown={() => host.current?.focus({ preventScroll: true })}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (renderer.current?.keyDown(event.code, event.shiftKey)) event.preventDefault();
      }}
      onKeyUp={(event) => renderer.current?.keyUp(event.code)}
      onBlur={() => renderer.current?.releaseKeys()}
    />
  );
}
