'use client';

import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  BoxGeometry,
  type BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { readPalette, type Palette } from './palette';

/**
 * The marketing hero's 3D scene: a gated estate seen from above, with the boom
 * gate cycling as a visitor is cleared through.
 *
 * Everything Three.js touches lives in this one module, and nothing imports it
 * except the `dynamic()` call in `hero-canvas.tsx`. That is deliberate: split
 * across two modules — a wrapper that lazily loads a canvas but takes meshes as
 * children — the caller still has to import Three.js to describe the meshes,
 * and the whole saving is lost.
 *
 * Driven imperatively rather than through React Three Fiber, which is pinned at
 * a version whose bundled reconciler reads React internals that React 19
 * removed; it throws on mount. Three.js on its own has no React coupling, and
 * skipping the reconciler makes this chunk smaller besides.
 */

/** Laid out by hand rather than randomised, so the composition is stable. */
const HOUSES = [
  { x: -3.1, z: -1.5, height: 0.85 },
  { x: -1.6, z: -2.2, height: 1.05 },
  { x: 0.1, z: -1.7, height: 0.8 },
  { x: 1.8, z: -2.3, height: 1.15 },
  { x: 3.2, z: -1.4, height: 0.9 },
  { x: -3.3, z: 1.4, height: 1.0 },
  { x: -1.7, z: 2.1, height: 0.8 },
  { x: 0.2, z: 1.5, height: 1.1 },
  { x: 1.9, z: 2.2, height: 0.85 },
  { x: 3.3, z: 1.3, height: 1.0 },
] as const;

const WALLS: ReadonlyArray<{
  position: [number, number, number];
  size: [number, number, number];
}> = [
  { position: [0, 0.3, -5.2], size: [13, 0.6, 0.22] },
  { position: [-6.4, 0.3, 0], size: [0.22, 0.6, 10.6] },
  { position: [6.4, 0.3, 0], size: [0.22, 0.6, 10.6] },
  { position: [-3.6, 0.3, 5.2], size: [5.8, 0.6, 0.22] },
  { position: [3.6, 0.3, 5.2], size: [5.8, 0.6, 0.22] },
];

export default function EstateScene() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    // Capped so a high-DPI phone does not render four times the pixels it needs
    // and drain the battery for a decorative background.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    container.append(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new Scene();
    const camera = new PerspectiveCamera(32, 1, 0.1, 120);

    const geometries: BufferGeometry[] = [];
    // Materials are keyed by token so a theme flip is a colour assignment
    // rather than a teardown and rebuild of the whole scene.
    const materials: Array<{ token: keyof Palette; material: MeshStandardMaterial }> = [];

    const material = (token: keyof Palette, palette: Palette, emissive = false) => {
      const created = new MeshStandardMaterial({ color: new Color(palette[token]), roughness: 0.8 });
      if (emissive) {
        created.emissive = new Color(palette[token]);
        created.emissiveIntensity = 0.6;
      }
      materials.push({ token, material: created });
      return created;
    };

    const geometry = <T extends BufferGeometry>(created: T): T => {
      geometries.push(created);
      return created;
    };

    let palette = readPalette();

    scene.add(new AmbientLight(0xffffff, 1.6));
    const key = new DirectionalLight(0xffffff, 1.7);
    key.position.set(4, 8, 5);
    scene.add(key);
    const fill = new DirectionalLight(new Color(palette.accent), 0.5);
    fill.position.set(-6, 3, -4);
    scene.add(fill);

    const ground = new Mesh(geometry(new PlaneGeometry(16, 12)), material('muted', palette));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);

    // The road in from the gate, which is what the eye follows.
    const road = new Mesh(geometry(new PlaneGeometry(1.4, 9)), material('border', palette));
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.01, 1);
    scene.add(road);

    const wallMaterial = material('border', palette);
    for (const wall of WALLS) {
      const mesh = new Mesh(geometry(new BoxGeometry(...wall.size)), wallMaterial);
      mesh.position.set(...wall.position);
      scene.add(mesh);
    }

    const wallsMaterial = material('background', palette);
    const roofMaterial = material('primary', palette);
    for (const house of HOUSES) {
      const body = new Mesh(geometry(new BoxGeometry(1.1, house.height, 1.1)), wallsMaterial);
      body.position.set(house.x, house.height / 2, house.z);
      scene.add(body);

      const roof = new Mesh(geometry(new ConeGeometry(0.95, 0.56, 4)), roofMaterial);
      roof.position.set(house.x, house.height + 0.28, house.z);
      roof.rotation.y = Math.PI / 4;
      scene.add(roof);
    }

    const gatehouse = new Mesh(geometry(new BoxGeometry(1.2, 0.9, 1.2)), wallsMaterial);
    gatehouse.position.set(1.5, 0.45, 5.2);
    scene.add(gatehouse);

    // The group is the hinge; the bar hangs off it, so rotating the group lifts
    // the boom about its post rather than about its own middle.
    const boom = new Group();
    boom.position.set(0.75, 0.55, 5.2);
    const bar = new Mesh(geometry(new BoxGeometry(1.7, 0.1, 0.12)), material('warning', palette));
    bar.position.x = -0.85;
    boom.add(bar);
    scene.add(boom);

    const post = new Mesh(
      geometry(new CylinderGeometry(0.1, 0.12, 0.56, 12)),
      material('foreground', palette),
    );
    post.position.set(0.75, 0.28, 5.2);
    scene.add(post);

    const beacon = new Mesh(
      geometry(new SphereGeometry(0.14, 16, 16)),
      material('success', palette, true),
    );
    beacon.position.set(-0.9, 0.95, 5.2);
    scene.add(beacon);

    const applyPalette = () => {
      palette = readPalette();
      for (const entry of materials) {
        entry.material.color.set(palette[entry.token]);
        if (entry.material.emissiveIntensity > 0) entry.material.emissive.set(palette[entry.token]);
      }
      fill.color.set(palette.accent);
    };

    // next-themes flips a class on <html>, so the tokens change underneath us
    // without anything in React re-rendering. Watching the attribute is what
    // keeps the scene in the same theme as the page around it.
    const themeObserver = new MutationObserver(applyPalette);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    let frame = 0;
    const started = performance.now();

    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const time = (now - started) / 1000;

      // A slow arc rather than a full orbit: the estate should read as a place
      // being looked at, not a product on a turntable.
      const sweep = Math.sin(time * 0.12) * 0.55;
      camera.position.set(Math.sin(sweep) * 15.5, 9.5, Math.cos(sweep) * 15.5);
      camera.lookAt(0, 0.2, 0);

      // One admission every eight seconds: raise, hold, lower, wait.
      const cycle = (time % 8) / 8;
      const open =
        cycle < 0.12 ? cycle / 0.12 : cycle < 0.5 ? 1 : cycle < 0.62 ? (0.62 - cycle) / 0.12 : 0;

      boom.rotation.z = open * (Math.PI / 2.2);
      const pulse = 1 + open * 0.6;
      beacon.scale.set(pulse, pulse, pulse);

      renderer.render(scene, camera);
    };

    // A background tab has no business holding a GPU loop open.
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(render);
    };
    document.addEventListener('visibilitychange', onVisibility);
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      for (const item of geometries) item.dispose();
      for (const entry of materials) entry.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
