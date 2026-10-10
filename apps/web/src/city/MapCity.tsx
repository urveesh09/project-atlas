import { useEffect, useRef } from 'react';
import { facadeColor, lensValue, type CityBuilding, type CityData, type CityLens } from '@atlas/layout';
import { EDGE_COLORS, edgeClass, type OverlayResult } from './overlay';
import type { CityHandle } from './types';

/** Same immutable rectangles as 3D; never reruns the layout. No WebGL dependency. */
export function MapCity(props: {
  city: CityData;
  /** Compare marks: outlined ghosts for deleted plots, a diamond for added files. */
  ghosts: readonly { rect: { x: number; z: number; width: number; depth: number }; kind: 'deleted' | 'added' }[];
  lens: CityLens;
  selected: ReadonlySet<string>;
  filter(b: CityBuilding): boolean;
  overlay: OverlayResult;
  focusNonce: number;
  select(id: string): void;
  register(handle: CityHandle | null): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    latest = useRef(props);
  latest.current = props;
  const view = useRef({ x: 0, z: 0, scale: 1 });
  // Frames share one plot plan: keep the view across snapshots, reset only for a new layout.
  const viewFor = useRef<string | null>(null);
  const drawRef = useRef<() => void>(() => {});
  useEffect(() => {
    const el = canvas.current!,
      ctx = el.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    const { city } = props;
    const draw = (target = el, context = ctx, scaleFactor = 1) => {
      const { lens, selected, filter, overlay } = latest.current;
      const v = view.current,
        s = v.scale * scaleFactor,
        tx = v.x * scaleFactor,
        tz = v.z * scaleFactor;
      const x = (n: number) => n * s + tx,
        z = (n: number) => n * s + tz;
      context.fillStyle = '#e9e4d7';
      context.fillRect(0, 0, target.width, target.height);
      for (const d of city.districts) {
        context.fillStyle = d.kind === 'package' ? '#cbcbb5' : d.depth % 2 ? '#e2ddc8' : '#d5d3bf';
        context.fillRect(x(d.rect.x), z(d.rect.z), d.rect.width * s, d.rect.depth * s);
        context.strokeStyle = '#7a887f';
        context.lineWidth = scaleFactor;
        context.strokeRect(x(d.rect.x), z(d.rect.z), d.rect.width * s, d.rect.depth * s);
      }
      for (const b of city.buildings) {
        context.globalAlpha = filter(b) ? 1 : 0.2;
        context.fillStyle = facadeColor(b, lens);
        const bx = x(b.rect.x),
          bz = z(b.rect.z),
          w = b.rect.width * s,
          h = b.rect.depth * s;
        context.fillRect(bx, bz, w, h);
        context.strokeStyle = '#475866';
        context.lineWidth = scaleFactor;
        if (w > 6) {
          context.strokeRect(bx, bz, w, h);
          context.beginPath();
          if (b.role === 'source') {
            context.moveTo(bx, bz + h);
            context.lineTo(bx + w / 2, bz);
            context.lineTo(bx + w, bz + h);
          } else if (b.role === 'test') {
            for (let side = 0; side <= 6; side++) {
              const a = (side * Math.PI) / 3,
                px = bx + w / 2 + (Math.cos(a) * w) / 3,
                py = bz + h / 2 + (Math.sin(a) * h) / 3;
              if (!side) context.moveTo(px, py);
              else context.lineTo(px, py);
            }
          } else if (b.role === 'declaration') {
            context.moveTo(bx, bz + h / 2);
            context.lineTo(bx + w, bz + h / 2);
          } else {
            context.rect(bx + w / 4, bz + h / 4, w / 2, h / 2);
          }
          context.stroke();
          if ((lens !== 'structure' && lensValue(b, lens) === null) || b.parseStatus !== 'parsed') {
            context.beginPath();
            context.moveTo(bx, bz);
            context.lineTo(bx + w, bz + h);
            context.moveTo(bx + w, bz);
            context.lineTo(bx, bz + h);
            context.stroke();
          }
        }
        context.globalAlpha = 1;
        if (selected.has(b.nodeId)) {
          context.strokeStyle = '#153d5c';
          context.lineWidth = 3 * scaleFactor;
          context.strokeRect(bx - 2, bz - 2, w + 4, h + 4);
        }
      }
      const terminals = overlay.promotedTerminal
        ? [...city.terminals.slice(0, 49), overlay.promotedTerminal]
        : city.terminals;
      for (const terminal of terminals) {
        context.fillStyle = '#607887';
        context.fillRect(x(terminal.x) - 3, z(terminal.z) - 3, 6, 6);
      }
      for (const ghost of latest.current.ghosts) {
        const gx = x(ghost.rect.x),
          gz = z(ghost.rect.z),
          w = Math.max(4, ghost.rect.width * s),
          h = Math.max(4, ghost.rect.depth * s);
        context.lineWidth = 2 * scaleFactor;
        if (ghost.kind === 'deleted') {
          context.strokeStyle = '#7a4f2a';
          context.setLineDash([3, 2]);
          context.strokeRect(gx - 1, gz - 1, w + 2, h + 2);
          context.setLineDash([]);
        } else {
          context.fillStyle = '#1f6b45';
          context.beginPath();
          context.moveTo(gx + w / 2, gz - 7);
          context.lineTo(gx + w / 2 + 5, gz - 2);
          context.lineTo(gx + w / 2, gz + 3);
          context.lineTo(gx + w / 2 - 5, gz - 2);
          context.closePath();
          context.fill();
        }
      }
      for (const arc of overlay.arcs) {
        context.strokeStyle = EDGE_COLORS[edgeClass(arc.kind)];
        context.lineWidth =
          arc.kind === 'package' ? Math.min(6, 1 + Math.log2(1 + arc.count)) * scaleFactor : 1.5 * scaleFactor;
        context.setLineDash(arc.kind.includes('type') ? [5, 3] : arc.kind.includes('dynamic') ? [2, 3] : []);
        context.beginPath();
        arc.points.forEach((p, i) => {
          if (i === 0) context.moveTo(x(p[0] * 100), z(p[2] * 100));
          else context.lineTo(x(p[0] * 100), z(p[2] * 100));
        });
        context.stroke();
        context.setLineDash([]);
        const end = arc.points.at(-1)!,
          prev = arc.points.at(-2)!;
        const ex = x(end[0] * 100),
          ez = z(end[2] * 100),
          angle = Math.atan2(end[2] - prev[2], end[0] - prev[0]);
        context.beginPath();
        context.moveTo(ex, ez);
        context.lineTo(ex - 8 * Math.cos(angle - 0.45), ez - 8 * Math.sin(angle - 0.45));
        context.moveTo(ex, ez);
        context.lineTo(ex - 8 * Math.cos(angle + 0.45), ez - 8 * Math.sin(angle + 0.45));
        context.stroke();
      }
      context.font = `${12 * scaleFactor}px system-ui`;
      context.textAlign = 'center';
      for (const d of city.districts.filter((d) => d.kind === 'package').slice(0, 20)) {
        const text = d.label.slice(0, 42),
          px = x(d.rect.x + d.rect.width / 2),
          pz = z(d.rect.z + 70),
          width = context.measureText(text).width + 10;
        context.fillStyle = '#faf8f2';
        context.fillRect(px - width / 2, pz - 12, width, 18);
        context.fillStyle = '#263344';
        context.fillText(text, px, pz + 1);
      }
    };
    const invalidate = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          draw();
        });
    };
    drawRef.current = invalidate;
    const reset = () => {
      const r = city.root;
      view.current.scale = Math.min(el.width / (r.width + 1800), el.height / (r.depth + 1800));
      view.current.x = (el.width - r.width * view.current.scale) / 2 - r.x * view.current.scale;
      view.current.z = (el.height - r.depth * view.current.scale) / 2 - r.z * view.current.scale;
      invalidate();
    };
    const zoom = (f: number) => {
      const v = view.current,
        s = Math.min(2, Math.max(0.001, v.scale * f)),
        ratio = s / v.scale;
      v.x = el.width / 2 + (v.x - el.width / 2) * ratio;
      v.z = el.height / 2 + (v.z - el.height / 2) * ratio;
      v.scale = s;
      invalidate();
    };
    const focus = (ids: ReadonlySet<string>) => {
      const files = city.buildings.filter((b) => ids.has(b.nodeId));
      if (!files.length) {
        reset();
        return;
      }
      const x = Math.min(...files.map((b) => b.rect.x)),
        z = Math.min(...files.map((b) => b.rect.z));
      const width = Math.max(...files.map((b) => b.rect.x + b.rect.width)) - x,
        depth = Math.max(...files.map((b) => b.rect.z + b.rect.depth)) - z;
      const v = view.current;
      v.scale = Math.min(el.width / (width + 600), el.height / (depth + 600));
      v.x = el.width / 2 - (x + width / 2) * v.scale;
      v.z = el.height / 2 - (z + depth / 2) * v.scale;
      invalidate();
    };
    props.register({
      reset,
      zoom,
      north: reset,
      focus,
      cameraState: () => ({ ...view.current }),
      exportPng: async () => {
        const scale = Math.min(2048 / el.width, 2048 / el.height, Math.sqrt(4_000_000 / (el.width * el.height)));
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.floor(el.width * scale));
        out.height = Math.max(1, Math.floor(el.height * scale));
        const context = out.getContext('2d');
        if (!context) throw new Error('Canvas export is unavailable');
        draw(out, context, scale);
        return new Promise<Blob>((resolve, reject) =>
          out.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
        );
      },
    });
    const observer = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      el.width = Math.max(1, Math.round(r.width));
      el.height = Math.max(1, Math.round(r.height));
      reset();
    });
    observer.observe(el);
    const controller = new AbortController(),
      signal = controller.signal;
    const pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
    let pinchDistance = 0;
    el.addEventListener(
      'pointerdown',
      (e) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
        el.setPointerCapture(e.pointerId);
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        }
      },
      { signal },
    );
    el.addEventListener(
      'pointermove',
      (e) => {
        const old = pointers.get(e.pointerId);
        if (!old) return;
        const dx = e.clientX - old.x,
          dy = e.clientY - old.y;
        old.x = e.clientX;
        old.y = e.clientY;
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
          if (pinchDistance > 0) zoom(distance / pinchDistance);
          pinchDistance = distance;
        } else {
          view.current.x += dx;
          view.current.z += dy;
          invalidate();
        }
      },
      { signal },
    );
    el.addEventListener(
      'pointerup',
      (e) => {
        const old = pointers.get(e.pointerId);
        pointers.delete(e.pointerId);
        if (!old || Math.hypot(e.clientX - old.startX, e.clientY - old.startY) >= 5 || pinchDistance) {
          if (!pointers.size) pinchDistance = 0;
          return;
        }
        const r = el.getBoundingClientRect(),
          v = view.current,
          x = (e.clientX - r.left - v.x) / v.scale,
          z = (e.clientY - r.top - v.z) / v.scale;
        const hit = city.buildings.find(
          (b) => x >= b.rect.x && x <= b.rect.x + b.rect.width && z >= b.rect.z && z <= b.rect.z + b.rect.depth,
        );
        if (hit) latest.current.select(hit.nodeId);
      },
      { signal },
    );
    el.addEventListener(
      'pointercancel',
      (e) => {
        pointers.delete(e.pointerId);
        pinchDistance = 0;
      },
      { signal },
    );
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
      },
      { signal, passive: false },
    );
    const layoutKey = `${city.root.x},${city.root.z},${city.root.width},${city.root.depth},${city.plotCount}`;
    if (viewFor.current !== layoutKey) {
      viewFor.current = layoutKey;
      reset();
    } else drawRef.current();
    return () => {
      controller.abort();
      observer.disconnect();
      cancelAnimationFrame(frame);
      props.register(null);
    };
  }, [props.city, props.register]);
  useEffect(() => {
    drawRef.current();
  }, [props.lens, props.selected, props.filter, props.overlay, props.ghosts]);
  useEffect(() => {
    if (props.focusNonce) {
      /* The toolbar invokes the registered handle directly. */
    }
  }, [props.focusNonce]);
  return (
    <canvas
      ref={canvas}
      className="city-canvas"
      data-city-renderer="map"
      role="img"
      aria-label="Repository map. Use search, tree or file table for keyboard selection."
    />
  );
}
