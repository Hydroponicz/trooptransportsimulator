import * as THREE from 'three';
import { merge, sp, box, cyl, pitchedRoof, house } from './props';

/**
 * Town and country architecture beyond the village houses in props.ts:
 * panel estates, Stalin-era blocks, shops, offices, schools, industry,
 * garages and petrol stations for the cities; farm buildings, fences and
 * livestock for the countryside; and street furniture. Big buildings get
 * their windows from the facade surfaces (see surfaces.ts), so they cost a
 * box rather than hundreds of window parts. Widths are whole multiples of
 * each facade's window spacing so the windows line up with the corners.
 */
export type CityProto =
  | 'block9'
  | 'tower16'
  | 'stalinka'
  | 'shops'
  | 'office'
  | 'school'
  | 'factory'
  | 'warehouse'
  | 'garages'
  | 'gasstation'
  | 'kiosk'
  | 'watertower'
  | 'chimney'
  | 'streettree'
  | 'parkedcar'
  | 'fence_board'
  | 'fence_rail'
  | 'cow'
  | 'haystack'
  | 'shed'
  | 'machineshed'
  | 'tractor_parked'
  | 'farmhouse'
  | 'monument'
  | 'fountain'
  | 'playground'
  | 'busstop'
  | 'plaza';

export const CITY_PROTOS: CityProto[] = [
  'block9', 'tower16', 'stalinka', 'shops', 'office', 'school', 'factory', 'warehouse', 'garages', 'gasstation', 'kiosk', 'watertower', 'chimney',
  'streettree', 'parkedcar', 'fence_board', 'fence_rail', 'cow', 'haystack', 'shed', 'machineshed', 'tractor_parked', 'farmhouse', 'monument',
  'fountain', 'playground', 'busstop', 'plaza',
];

/** Footprint (local x × z, metres) of the buildings the city planner fits into blocks. */
export const FOOTPRINT: Partial<Record<string, [number, number]>> = {
  apartment: [24, 12],
  block9: [36, 12],
  tower16: [18, 18],
  stalinka: [33, 13.2],
  shops: [26.4, 13.2],
  office: [28.8, 16],
  school: [46.2, 13.2],
  factory: [55.4, 24],
  warehouse: [30, 18],
  garages: [25.6, 6],
  gasstation: [24, 16],
};

/** Collides with aircraft and vehicles. */
export const CITY_COLLIDE: Record<CityProto, boolean> = {
  block9: true, tower16: true, stalinka: true, shops: true, office: true, school: true, factory: true, warehouse: true, garages: true,
  gasstation: true, kiosk: true, watertower: true, chimney: true, streettree: true, parkedcar: true, fence_board: true, fence_rail: true,
  cow: false, haystack: true, shed: true, machineshed: true, tractor_parked: true, farmhouse: true, monument: true, fountain: true,
  playground: false, busstop: true, plaza: false,
};

/** View distances (unlisted: 4 km). Tall buildings stay to the fog. */
export const CITY_VIEW: Partial<Record<CityProto, number>> = {
  block9: 7500, tower16: 7500, stalinka: 7000, office: 7000, factory: 7000, chimney: 7500, watertower: 7500, school: 6000,
  streettree: 1800, parkedcar: 900, fence_board: 1100, fence_rail: 1000, cow: 900, haystack: 1500, kiosk: 900, playground: 800,
  busstop: 900, fountain: 1200, monument: 2500, tractor_parked: 1200, plaza: 2500,
};

const CONCRETE = 0x9b978d;

/** A flat roof with a parapet over a W × D block of height H. */
function flatRoof(p: THREE.BufferGeometry[], W: number, D: number, H: number) {
  p.push(sp('concrete', false, box(W + 0.3, 0.6, D + 0.3), CONCRETE, 0, H + 0.3, 0));
  p.push(sp('plain', false, box(W - 0.5, 0.06, D - 0.5), 0x3a3a38, 0, H + 0.58, 0));
}

/** Nine-storey precast panel slab: balconies on the front, three entrances at the back, lift rooms on the roof. */
function block9() {
  const W = 36;
  const D = 12;
  const H = 9 * 2.8;
  const p: THREE.BufferGeometry[] = [sp('facade_panel', true, box(W, H, D), 0xe0dccf, 0, H / 2, 0)];
  flatRoof(p, W, D, H);
  const balc = [0xc9c4b6, 0xa7b5a0, 0xd8cdb2, 0x9fb0bd, 0xc6c0b0, 0xb9a99a];
  for (let f = 1; f < 9; f++)
    for (let i = 0; i < 12; i += 2) {
      const x = -W / 2 + 3 * i + 4.5;
      const y = f * 2.8;
      p.push(sp('concrete', false, box(2.9, 0.16, 1.1), CONCRETE, x, y + 0.02, D / 2 + 0.55));
      const c = balc[(i * 7 + f * 5) % balc.length];
      p.push(sp((i + f) % 3 === 0 ? 'glass' : 'concrete', false, box(2.9, 1.0, 0.07), (i + f) % 3 === 0 ? 0x1e262c : c, x, y + 0.6, D / 2 + 1.08));
    }
  for (const x of [-12, 0, 12]) {
    p.push(sp('concrete', false, box(2.8, 0.2, 1.8), CONCRETE, x, 2.75, -D / 2 - 0.9));
    p.push(sp('wood', false, box(1.6, 2.3, 0.12), 0x4c4136, x, 1.15, -D / 2 - 0.05));
    p.push(sp('concrete', false, box(2.6, 0.3, 1.6), 0x8e8b84, x, 0.15, -D / 2 - 0.8));
    p.push(sp('concrete', false, box(3.2, 2.4, 2.6), 0xb0aca2, x, H + 1.8, 0));
  }
  return merge(p);
}

/** Sixteen-storey point block with a stair/lift spine and a machine room on top. */
function tower16() {
  const W = 18;
  const H = 16 * 2.8;
  const p: THREE.BufferGeometry[] = [sp('facade_panel', true, box(W, H, W), 0xe6e1d3, 0, H / 2, 0)];
  flatRoof(p, W, W, H);
  p.push(sp('concrete', true, box(3.2, H + 3, 2.4), 0xd2cdbf, 0, (H + 3) / 2, -W / 2 - 1.1));
  p.push(sp('concrete', false, box(5, 3, 5), 0xb0aca2, 0, H + 2.1, 0));
  p.push(sp('concrete', false, box(4, 0.25, 2.5), CONCRETE, 0, 3.0, W / 2 + 1.2));
  p.push(sp('glass', false, box(2.4, 2.6, 0.1), 0x1e262c, 0, 1.3, W / 2 + 0.02));
  p.push(sp('paint', false, cyl(0.05, 0.05, 6, 4), 0x8a8a8a, 4, H + 3.6, 4));
  return merge(p);
}

/** Five-storey Stalin-era block: rendered walls, pilasters, heavy cornice, shops behind big windows on the ground floor. */
function stalinka() {
  const W = 33;
  const D = 13.2;
  const H = 5 * 3.3;
  const p: THREE.BufferGeometry[] = [sp('facade_plaster', true, box(W, H, D), 0xf0e2c4, 0, H / 2, 0)];
  // Rusticated ground floor with shop windows on the street side.
  p.push(sp('plaster', false, box(W + 0.1, 3.3, D + 0.1), 0xb9ab92, 0, 1.65, 0));
  for (let i = 0; i < 5; i++) {
    const x = -W / 2 + 3.3 + i * 6.6;
    p.push(sp('glass', false, box(4.6, 2.4, 0.1), 0x1e262c, x, 1.55, D / 2 + 0.06));
    p.push(sp('paint', false, box(5.0, 0.5, 0.12), [0x3d6b4a, 0x7a2e2a, 0x2e4a6e, 0x8a6a2a, 0x3d6b4a][i], x, 3.0, D / 2 + 0.1));
  }
  // Pilasters and cornice.
  for (let i = 0; i <= 5; i++) p.push(sp('plaster', true, box(0.5, H - 3.3, 0.3), 0xf6ecd6, -W / 2 + i * 6.6, 3.3 + (H - 3.3) / 2, D / 2 + 0.15));
  p.push(sp('plaster', false, box(W + 1.2, 0.7, D + 1.2), 0xe8dcc4, 0, H + 0.35, 0));
  pitchedRoof(p, W - 0.5, D - 0.5, H + 0.7, 3.2, 'sheet', 0x5f6a62, 'plaster', 0xf0e2c4, true);
  return merge(p);
}

/** Three storeys of flats over a row of shops with awnings and signs. */
function shops() {
  const W = 26.4;
  const D = 13.2;
  const H = 3 * 3.3;
  const p: THREE.BufferGeometry[] = [sp('facade_plaster', true, box(W, H, D), 0xf2ead8, 0, H / 2, 0)];
  p.push(sp('plaster', false, box(W + 0.1, 3.3, D + 0.1), 0xd8d0be, 0, 1.65, 0));
  const awn = [0xb8352c, 0x2f6a8a, 0x3f7a3a, 0xd89a2a];
  for (let i = 0; i < 4; i++) {
    const x = -W / 2 + 3.3 + i * 6.6;
    p.push(sp('glass', false, box(5.2, 2.5, 0.1), 0x1e262c, x, 1.5, D / 2 + 0.06));
    p.push(sp('canvas', false, box(5.6, 0.08, 1.6), awn[i], x, 3.0, D / 2 + 0.8, -0.35, 0, 0));
    p.push(sp('paint', false, box(4.2, 0.6, 0.1), [0xf2f0e8, 0xffd23a, 0xf2f0e8, 0x2a2a2a][i], x, 3.6, D / 2 + 0.1));
  }
  flatRoof(p, W, D, H);
  return merge(p);
}

/** Four-storey office block with ribbon glazing. */
function office() {
  const W = 28.8;
  const D = 16;
  const H = 4 * 3.4;
  const p: THREE.BufferGeometry[] = [sp('facade_glass', true, box(W, H, D), 0xb7c0c4, 0, H / 2, 0)];
  flatRoof(p, W, D, H);
  p.push(sp('concrete', false, box(8, 0.3, 4), CONCRETE, 0, 3.6, D / 2 + 2));
  for (const x of [-3.6, 3.6]) p.push(sp('concrete', false, box(0.4, 3.5, 0.4), CONCRETE, x, 1.75, D / 2 + 3.6));
  p.push(sp('concrete', false, box(6, 2.5, 4), 0xa8a59e, 6, H + 1.6, 0));
  return merge(p);
}

/** Three-storey school with a columned entrance and a sports pitch out front. */
function school() {
  const W = 46.2;
  const D = 13.2;
  const H = 3 * 3.3;
  const p: THREE.BufferGeometry[] = [sp('facade_plaster', true, box(W, H, D), 0xf1e3c4, 0, H / 2, 0)];
  flatRoof(p, W, D, H);
  p.push(sp('plaster', false, box(10, 0.5, 4), 0xe8e2d4, 0, 4.1, D / 2 + 2));
  for (const x of [-4, -1.4, 1.4, 4]) p.push(sp('plaster', false, cyl(0.3, 0.3, 4, 10), 0xf2efe6, x, 2, D / 2 + 3.6));
  // Pitch with goals.
  p.push(sp('plain', false, box(36, 0.06, 18), 0x5d7a42, 0, 0.03, D / 2 + 16));
  p.push(sp('plain', false, box(36.4, 0.07, 0.15), 0xf2f0ea, 0, 0.04, D / 2 + 7));
  p.push(sp('plain', false, box(36.4, 0.07, 0.15), 0xf2f0ea, 0, 0.04, D / 2 + 25));
  for (const sx of [-1, 1]) p.push(sp('paint', false, box(0.12, 2.2, 5), 0xf2f0ea, sx * 18, 1.1, D / 2 + 16));
  return merge(p);
}

/** Factory hall: brick walls with big steel windows, a sawtooth north-light roof, an office annex. */
function factory() {
  const W = 42;
  const D = 24;
  const H = 8;
  // The office annex sticks out on the -X end; shift the whole so the footprint is centred.
  const OX = 6.7;
  const p: THREE.BufferGeometry[] = [sp('facade_brick', false, box(W, H, D), 0xa7614a, OX, H / 2, 0)];
  // Sawtooth roof: bays across the hall, each a sloped sheet and a glazed upstand.
  const bays = 6;
  const bw = D / bays;
  for (let i = 0; i < bays; i++) {
    const z = -D / 2 + bw * (i + 0.5);
    const a = Math.atan2(2.2, bw);
    p.push(sp('sheet', false, box(W, 0.15, Math.hypot(bw, 2.2)), 0x8a8c86, OX, H + 1.1, z, a, 0, 0));
    p.push(sp('glass', false, box(W, 2.2, 0.1), 0x2a3640, OX, H + 1.1, z + bw / 2 - 0.05));
  }
  p.push(sp('facade_plaster', true, box(13.2, 9.9, 9.9), 0xe0d8c4, OX - W / 2 - 6.6, 4.95, D / 2 - 5));
  p.push(sp('concrete', false, box(13.6, 0.4, 10.3), CONCRETE, OX - W / 2 - 6.6, 10.1, D / 2 - 5));
  // Loading doors.
  for (const x of [-8, 8]) p.push(sp('metal', false, box(5, 5, 0.15), 0x5a6a6e, OX + x, 2.5, D / 2 + 0.08));
  return merge(p);
}

/** Corrugated steel warehouse with loading doors and a canopy. */
function warehouse() {
  const W = 30;
  const D = 18;
  const H = 8;
  const p: THREE.BufferGeometry[] = [sp('metal', true, box(W, H, D), 0xb8bcb8, 0, H / 2, 0)];
  pitchedRoof(p, W, D, H, 2.2, 'sheet', 0x7d807a, 'metal', 0xb8bcb8, true);
  for (const x of [-9, 0, 9]) p.push(sp('metal', false, box(4.5, 4.5, 0.12), 0x4c5a64, x, 2.25, D / 2 + 0.07));
  p.push(sp('sheet', false, box(W, 0.12, 3), 0x7d807a, 0, 5.2, D / 2 + 1.5, -0.12, 0, 0));
  p.push(sp('concrete', false, box(W + 2, 1.1, 4), CONCRETE, 0, 0.55, D / 2 + 2));
  return merge(p);
}

/** A row of lock-up garages, each door its own colour. */
function garages() {
  const n = 8;
  const w = 3.2;
  const p: THREE.BufferGeometry[] = [sp('brick', false, box(n * w, 2.6, 6), 0x9c6650, 0, 1.3, 0)];
  p.push(sp('concrete', false, box(n * w + 0.4, 0.2, 6.4), CONCRETE, 0, 2.7, 0));
  const doors = [0x3e6a4a, 0x3a5a7a, 0x6a4a32, 0x7a7a72, 0x8a3a2a, 0x3e6a4a, 0x5a5a7a, 0x8a7a3a];
  for (let i = 0; i < n; i++) p.push(sp('metal', false, box(2.6, 2.1, 0.08), doors[i], -(n * w) / 2 + w * (i + 0.5), 1.05, 3.04));
  return merge(p);
}

/** Petrol station: canopy over two pump islands, a shop, a price sign. */
function gasstation() {
  const p: THREE.BufferGeometry[] = [
    sp('concrete', false, box(24, 0.1, 16), 0x8e8b84, 0, 0.05, 0),
    sp('paint', false, box(14, 1.0, 9), 0xf2f0ea, 0, 5.5, 2),
    sp('paint', false, box(14.1, 0.3, 9.1), 0x2a6a3a, 0, 5.2, 2),
  ];
  for (const x of [-5.5, 5.5]) for (const z of [-1, 5]) p.push(sp('paint', false, box(0.4, 5, 0.4), 0xd8d8d0, x, 2.5, z));
  for (const x of [-3, 3]) {
    p.push(sp('concrete', false, box(1.2, 0.2, 5), CONCRETE, x, 0.15, 2));
    for (const z of [0.6, 3.4]) p.push(sp('paint', false, box(0.7, 1.6, 0.5), 0x2a6a3a, x, 1.0, z));
  }
  p.push(sp('facade_glass', true, box(9.6, 3.4, 6.4), 0xe8e6e0, -2, 1.7, -5.5));
  p.push(sp('paint', false, box(10, 0.3, 6.8), 0x2a6a3a, -2, 3.55, -5.5));
  p.push(sp('paint', false, box(0.3, 6, 0.3), 0xd8d8d0, 10, 3, 6.5));
  p.push(sp('paint', false, box(2.4, 3, 0.25), 0x2a6a3a, 10, 6.5, 6.5));
  p.push(sp('paint', false, box(2.2, 1.8, 0.27), 0xf2f0ea, 10, 6.3, 6.5));
  return merge(p);
}

/** Lime tree for streets and parks: a tall clear trunk and a rounded crown. */
function streettree() {
  return merge([
    sp('bark', true, cyl(0.15, 0.24, 4.2, 6), 0x4d3c29, 0, 2.1, 0),
    sp('foliage', true, new THREE.IcosahedronGeometry(2.4, 1), 0x4f7030, 0, 5.6, 0, 0, 0, 0, 1, 0.9, 1),
    sp('foliage', true, new THREE.IcosahedronGeometry(1.6, 0), 0x57782f, 1.1, 4.8, 0.6),
    sp('foliage', true, new THREE.IcosahedronGeometry(1.5, 0), 0x4a6a2c, -1.0, 5.0, -0.7),
  ]);
}

/** Parked family saloon (tinted per instance). Faces +Z. */
function parkedcar() {
  const p: THREE.BufferGeometry[] = [
    sp('paint', true, box(1.7, 0.62, 4.3), 0xffffff, 0, 0.62, 0),
    sp('paint', true, box(1.5, 0.55, 2.2), 0xffffff, 0, 1.2, -0.2),
    sp('glass', false, box(1.4, 0.45, 2.24), 0x1e262c, 0, 1.2, -0.2),
    sp('glass', false, box(1.52, 0.44, 2.0), 0x1e262c, 0, 1.2, -0.2),
    sp('plain', false, box(1.72, 0.18, 0.1), 0x2a2a2a, 0, 0.42, 2.15),
    sp('plain', false, box(1.72, 0.18, 0.1), 0x2a2a2a, 0, 0.42, -2.15),
  ];
  for (const x of [-0.78, 0.78]) for (const z of [-1.35, 1.35]) p.push(sp('plain', false, cyl(0.31, 0.31, 0.22, 10), 0x1a1a18, x, 0.31, z, 0, 0, Math.PI / 2));
  return merge(p);
}

/** Solid board fence, 4 m, along local X. */
function fenceBoard() {
  return merge([
    sp('wood', true, box(4, 1.6, 0.05), 0x7a6448, 0, 0.9, 0),
    sp('wood', true, box(0.12, 1.8, 0.12), 0x5a4834, -2, 0.9, -0.06),
    sp('wood', true, box(4, 0.08, 0.08), 0x5a4834, 0, 0.5, -0.06),
    sp('wood', true, box(4, 0.08, 0.08), 0x5a4834, 0, 1.4, -0.06),
  ]);
}

/** Post-and-rail pasture fence, 6 m, along local X. */
function fenceRail() {
  const p: THREE.BufferGeometry[] = [];
  for (const x of [-3, 0]) p.push(sp('wood', true, box(0.14, 1.3, 0.14), 0x5f4c36, x, 0.62, 0));
  for (const y of [0.45, 0.8, 1.15]) p.push(sp('wood', true, box(6, 0.09, 0.06), 0x6e5a42, 0, y, 0.06));
  return merge(p);
}

/** Dairy cow, facing +Z (tinted: brown, black-and-white, red). */
function cow() {
  const p: THREE.BufferGeometry[] = [
    sp('plain', true, box(0.8, 0.85, 1.9), 0xffffff, 0, 1.15, 0),
    sp('plain', false, box(0.82, 0.5, 0.7), 0xf2f0ea, 0, 1.2, -0.3),
    sp('plain', true, box(0.42, 0.45, 0.6), 0xffffff, 0, 1.4, 1.15, -0.4, 0, 0),
    sp('plain', false, box(0.3, 0.2, 0.2), 0xd8a898, 0, 1.25, 1.45),
    sp('plain', false, box(0.36, 0.16, 0.35), 0xd8a898, 0, 0.72, -0.35),
  ];
  for (const x of [-0.28, 0.28]) for (const z of [-0.7, 0.7]) p.push(sp('plain', true, box(0.16, 0.75, 0.16), 0xffffff, x, 0.37, z));
  p.push(sp('plain', true, box(0.06, 0.8, 0.06), 0xffffff, 0, 0.95, -0.98, 0.25, 0, 0));
  return merge(p);
}

/** Traditional haystack round a pole. */
function haystack() {
  return merge([
    sp('hay', true, cyl(1.8, 2.1, 2.2, 12), 0xc4ad62, 0, 1.1, 0),
    sp('hay', true, new THREE.ConeGeometry(1.9, 2.4, 12), 0xb9a25a, 0, 3.4, 0),
    sp('wood', false, cyl(0.06, 0.06, 1.2, 5), 0x4d3c29, 0, 4.9, 0),
  ]);
}

/** Small timber shed with a pitched sheet roof. */
function shed() {
  const p: THREE.BufferGeometry[] = [sp('wood', true, box(4, 2.4, 3), 0x7a6448, 0, 1.2, 0)];
  pitchedRoof(p, 4, 3, 2.4, 1.0, 'sheet', 0x7d807a, 'wood', 0x7a6448, true);
  p.push(sp('wood', false, box(1, 1.9, 0.08), 0x4a3828, 0, 0.95, 1.52));
  return merge(p);
}

/** Open-sided machinery shed: posts and a long sheet roof. */
function machineshed() {
  const p: THREE.BufferGeometry[] = [];
  for (const x of [-8, -2.7, 2.7, 8]) for (const z of [-5, 5]) p.push(sp('wood', false, box(0.3, 5, 0.3), 0x5a4834, x, 2.5, z));
  pitchedRoof(p, 10.5, 16.5, 5, 1.8, 'sheet', 0x8a8c86, 'wood', 0x6e5a42, false);
  p.push(sp('wood', false, box(16.5, 2.5, 0.12), 0x6e5a42, 0, 1.25, -5.1));
  return merge(p);
}

/** A tractor standing in a yard (tinted: red, blue, green). Faces +Z. */
export function tractorParts(tintBody = true) {
  const p: THREE.BufferGeometry[] = [
    sp('paint', tintBody, box(1.0, 0.9, 2.4), 0xffffff, 0, 1.15, 0.6),
    sp('paint', tintBody, box(1.1, 0.25, 1.6), 0xffffff, 0, 0.75, -0.6),
    sp('glass', false, box(1.3, 1.3, 1.3), 0x2a3640, 0, 2.15, -0.7),
    sp('paint', tintBody, box(1.45, 0.12, 1.5), 0xffffff, 0, 2.86, -0.7),
    sp('paint', false, box(1.25, 0.25, 1.25), 0x2a2a2a, 0, 1.45, -0.7),
    sp('paint', false, cyl(0.06, 0.06, 1.2, 5), 0x2a2a2a, 0.35, 2.3, 1.2),
  ];
  for (const sx of [-1, 1]) {
    p.push(sp('plain', false, cyl(0.85, 0.85, 0.5, 14), 0x1c1c1a, sx * 1.0, 0.85, -0.8, 0, 0, Math.PI / 2));
    p.push(sp('plain', false, cyl(0.48, 0.48, 0.32, 12), 0x1c1c1a, sx * 0.78, 0.48, 1.4, 0, 0, Math.PI / 2));
    p.push(sp('paint', tintBody, box(0.55, 0.08, 1.4), 0xffffff, sx * 1.0, 1.75, -0.8));
  }
  return p;
}

/** Village farmhouse: a long single-storey house with a porch, from the house builder. */
function farmhouse() {
  return house({ w: 8, d: 13, floors: 1, wall: 'plaster', roof: 'sheet', roofColor: 0x8f918a, shutters: 0x3a6688, porch: true });
}

/** War memorial: stepped granite plinth and a bronze figure. */
function monument() {
  return merge([
    sp('concrete', false, box(8, 0.6, 8), 0x8e8a84, 0, 0.3, 0),
    sp('concrete', false, box(3.2, 3.6, 2.4), 0x6a6862, 0, 2.4, 0),
    sp('paint', false, box(0.9, 2.6, 0.6), 0x4a4a38, 0, 5.5, 0),
    sp('paint', false, box(1.2, 0.8, 0.7), 0x4a4a38, 0, 6.6, 0),
    sp('paint', false, new THREE.SphereGeometry(0.32, 8, 6), 0x4a4a38, 0, 7.25, 0),
    sp('paint', false, box(0.25, 1.6, 0.25), 0x4a4a38, 0.6, 7.2, 0.1, 0, 0, -0.5),
  ]);
}

function fountain() {
  return merge([
    sp('concrete', false, cyl(4.5, 4.7, 0.7, 24), 0xa8a49a, 0, 0.35, 0),
    sp('glass', false, cyl(4.1, 4.1, 0.1, 24), 0x3a5a6a, 0, 0.62, 0),
    sp('concrete', false, cyl(0.5, 0.7, 2.2, 10), 0xa8a49a, 0, 1.1, 0),
    sp('concrete', false, cyl(1.4, 1.2, 0.3, 14), 0xa8a49a, 0, 2.2, 0),
  ]);
}

function playground() {
  const p: THREE.BufferGeometry[] = [sp('plain', false, box(14, 0.05, 10), 0xb09a72, 0, 0.03, 0)];
  // Swings, a climbing frame and a slide.
  for (const x of [-5, -2]) p.push(sp('paint', false, box(0.12, 2.4, 0.12), 0xb8352c, x, 1.2, -3));
  p.push(sp('paint', false, box(3.2, 0.12, 0.12), 0xb8352c, -3.5, 2.4, -3));
  p.push(sp('paint', false, box(3, 2, 3), 0x2f6a8a, 3, 1, 1));
  p.push(sp('paint', false, box(0.8, 0.08, 3.4), 0xd89a2a, 3, 1.1, 4, 0.55, 0, 0));
  return merge(p);
}

function busstop() {
  return merge([
    sp('paint', false, box(4, 0.1, 1.6), 0x3a5a6a, 0, 2.5, 0),
    sp('glass', false, box(4, 2.2, 0.06), 0x2a3640, 0, 1.3, -0.75),
    sp('paint', false, box(0.1, 2.5, 0.1), 0x6a6a6a, -1.9, 1.25, -0.7),
    sp('paint', false, box(0.1, 2.5, 0.1), 0x6a6a6a, 1.9, 1.25, -0.7),
    sp('wood', false, box(3, 0.08, 0.4), 0x6e5a42, 0, 0.5, -0.5),
  ]);
}

/** Paved town square (scaled per use). */
function plaza() {
  return merge([sp('concrete', true, box(1, 0.08, 1), 0xb6b0a4, 0, 0.04, 0)]);
}

function watertower() {
  return merge([
    sp('concrete', false, cyl(1.3, 1.8, 22, 12), 0xb0aca2, 0, 11, 0),
    sp('paint', false, cyl(4.2, 3.0, 5, 16), 0xd8d4c8, 0, 24.5, 0),
    sp('paint', false, new THREE.ConeGeometry(4.4, 1.6, 16), 0x8a8c86, 0, 27.8, 0),
  ]);
}

/** Factory smokestack: tapering brick, red-and-white bands at the top. */
function chimney() {
  const p: THREE.BufferGeometry[] = [sp('brick', false, cyl(1.3, 2.3, 44, 12), 0x9c5a44, 0, 22, 0)];
  for (let i = 0; i < 3; i++) p.push(sp('paint', false, cyl(1.36 + i * 0.07, 1.38 + i * 0.07, 2, 12), i % 2 ? 0xf2f0ea : 0xb8352c, 0, 42 - i * 2.2, 0));
  return merge(p);
}

export function buildCityProto(name: CityProto): THREE.BufferGeometry {
  switch (name) {
    case 'block9':
      return block9();
    case 'tower16':
      return tower16();
    case 'stalinka':
      return stalinka();
    case 'shops':
      return shops();
    case 'office':
      return office();
    case 'school':
      return school();
    case 'factory':
      return factory();
    case 'warehouse':
      return warehouse();
    case 'garages':
      return garages();
    case 'gasstation':
      return gasstation();
    case 'kiosk':
      return merge([
        sp('paint', true, box(2.6, 2.6, 2.2), 0xffffff, 0, 1.3, 0),
        sp('glass', false, box(1.8, 1.0, 0.08), 0x1e262c, 0, 1.5, 1.12),
        sp('canvas', true, box(3, 0.08, 1.0), 0xffffff, 0, 2.5, 1.5, -0.3, 0, 0),
      ]);
    case 'watertower':
      return watertower();
    case 'chimney':
      return chimney();
    case 'streettree':
      return streettree();
    case 'parkedcar':
      return parkedcar();
    case 'fence_board':
      return fenceBoard();
    case 'fence_rail':
      return fenceRail();
    case 'cow':
      return cow();
    case 'haystack':
      return haystack();
    case 'shed':
      return shed();
    case 'machineshed':
      return machineshed();
    case 'tractor_parked':
      return merge(tractorParts());
    case 'farmhouse':
      return farmhouse();
    case 'monument':
      return monument();
    case 'fountain':
      return fountain();
    case 'playground':
      return playground();
    case 'busstop':
      return busstop();
    case 'plaza':
      return plaza();
  }
}
