# Troop Transport Simulator

A 3D helicopter logistics game, inspired by Euro Truck Simulator. You fly a
CH-47-style tandem-rotor transport, picking up infantry, casualties, pallets
and sling loads, and delivering them across a procedurally generated warzone,
from the safe rear bases to outposts on the front line and landing zones
behind enemy lines.

It runs in the browser (Three.js + TypeScript + Vite). No assets: every model,
texture and sound is generated in code.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (can be hosted anywhere, e.g. GitHub Pages)
```

You need a browser with WebGL. A gamepad is optional.

## The loop

1. **Pick a job.** Land at a base, FOB or outpost and open the terminal (`Tab`).
   Contracts list the cargo, the route, the distance, the time limit, the risk
   and the pay. Harder work unlocks as you rank up.
2. **Load up.** Land near the green smoke and lower the ramp (`R`). Troops,
   litter teams and pallet crews walk aboard, and every passenger adds real
   mass to the aircraft. For sling loads, hover with the hook over the load,
   2–9 m up, and press `H`. The hook camera (`C`) and the drift display help.
3. **Fly it.** Watch torque, rotor RPM, fuel and your cargo condition. Hard
   g-loads, steep banks, hits and rough landings all damage the cargo, and the
   cargo's condition sets your pay.
4. **Deliver.** Land by the yellow smoke (red means a hot LZ), lower the ramp
   and let everyone off, or set the sling load down gently inside the smoke
   and release it.
5. **Get paid.** The payout breaks down bonuses (early delivery, golden hour,
   smooth ride, butter landing, precise set-down, hazard pay) and penalties.
   Spend the money on fuel, repairs, flares and hangar upgrades: engines,
   armor, fuel tanks and countermeasures.

## Flight model

The flight model is a rigid body simulated at 120 Hz:

- Rotor thrust scales with collective, rotor RPM², air density, **ground
  effect** (more lift near the ground) and **translational lift** (the
  shudder and extra lift as you pass about 10–30 kt).
- **Vortex ring state**: descend faster than about 5 m/s with little forward
  speed and you lose lift and get buffeted. To recover, fly forward out of it.
- **Rotor droop and overtorque**: heavy loads need more collective. Above
  about 93% collective the rotor RPM sags, and sustained overtorque damages
  the drivetrain.
- **Autorotation**: if the engines quit, the rotor windmills on the descending
  airflow. Lower the collective to keep the RPM up.
- Mass and inertia change with fuel, passengers and armor. A slung load is a
  real pendulum on a rope that tugs the aircraft around.
- Weathervaning, coordinated turns at speed, wind and gusts, and a spring and
  damper landing gear with brakes. The game rates every touchdown, from
  BUTTER to VERY HARD.

**Stability assist** (`T`) has three levels:
- **Rate**: manual. The stick commands rotation rates.
- **Attitude hold** (default): the stick commands bank and pitch angles, and
  the aircraft levels itself when you let go.
- **Hover hold**: like attitude hold, but at low speed with the stick centered
  it also cancels drift. Useful for sling work.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Pitch: nose down (forward) / nose up |
| `A` / `D` | Roll left / right (arrow keys also work for pitch & roll) |
| `Q` / `E` | Yaw left / right |
| `Shift` / `Ctrl` | Collective up / down (climb / descend); `Space` also climbs |
| `I` | Start / stop engines |
| `R` | Raise / lower ramp |
| `H` | Hook / release sling load |
| `F` | Flares |
| `T` | Stability assist mode |
| `C` | Camera: chase / cockpit / hook / cinematic |
| Mouse drag, wheel | Look around, zoom |
| `B` | Look back |
| `Tab` | Base terminal |
| `M` | Theater map |
| `Esc` / `P` | Pause |

The game goes fullscreen with keyboard lock when you start or continue a
career, so in Chrome and Edge Ctrl+W / Ctrl+Q go to the game instead of
closing the browser. Hold Esc to leave fullscreen; the game pauses and offers
a one-click way back. Firefox and Safari don't support keyboard lock.

Gamepad: the left stick is collective and yaw, the right stick is cyclic, and
the triggers also move the collective. A = ramp, B = hook, X = engine,
Y = camera, LB = flares, RB = SAS, Start = terminal.

## The world

Each career has a seed that generates an 8 × 8 km theater: rolling hills, a
river crossed by bridges, mountains around the edges, and a winding **front
line** (friendly to the west, enemy to the east) scarred with craters,
burning wrecks, artillery and tracer fire. The ground flattens out near the
front so battles happen on sensible terrain. Places include:

- **Main operating base**: hangars, fuel farm, upgrades.
- **FOBs**: fuel, repair and flares.
- **Combat outposts** near the front.
- **Landing zones**: open fields, some behind enemy lines.
- **Towns**:
  - Contested towns straddle the front, ruined and fought over.
  - Intact villages sit behind each line, with streets, apartment blocks, a
    church, and farmland, barns and silos around them.

Roads link everything (with power lines along the main supply routes), and
supply convoys drive them.

### The war

The front is split into 10 sectors (A–J) that track both sides' infantry,
armor, fortifications, ammo and artillery. Sectors far from you fight on as
numbers. Near you they become real battles: trench lines dug by engineers,
squads assaulting across no-man's land, APCs bringing reinforcements, tank
duels and artillery. A sector with a contested town fights around it. Every
casualty is written back to the campaign, and your deliveries change it:
troops reinforce, ammo boosts firepower, supplies fortify, howitzers add
artillery, vehicles add armor. The **Front** tab and the theater map show
the state of each sector.

Close air support flies its own missions. A-10s strafe enemy positions with
their 30 mm cannon (you hear the BRRRT after the impacts), and Su-25s make
rocket and bomb runs on friendly lines. Both pop flares as they leave, and
sometimes one gets shot down.

Enemy machine guns, AA guns and MANPADS hold the far side of the line. Low
and fast is harder to hit, and terrain blocks line of sight. Missiles can be
decoyed with flares. Hot LZs bring extra gun positions and mortar fire.

Progress (money, rank, upgrades, stats, seed) is saved in `localStorage`.

## Code map

```
src/
  main.ts            menu, launching a career
  game.ts            game loop, glue between systems, prompts, crash/respawn
  heli/flight.ts     flight model (thrust, drag, control laws, ground contact)
  heli/heli.ts       aircraft entity: damage, ramp, rotors, collisions
  heli/chinookModel.ts  procedural CH-47 mesh
  game/missions.ts   contracts, pay, mission phases, payouts
  game/cargo.ts      troops / litters / pallets walking on and off the ramp
  game/sling.ts      hook, rope constraint, slung-load physics
  game/threats.ts    enemy fire, missiles, flares, mortars, ambient battle
  battle/            campaign sectors, materialized battles, trenches, AI aircraft
  game/career.ts     ranks, upgrades, save data
  world/             terrain, front line, sites, towns, props, roads/bridges, forests, sky
  fx/                particles (dust, smoke, fire), tracers, explosions
  audio.ts           synthesized rotor, turbine, wind and effects audio
  ui/                HUD, minimap and theater map, terminal and dialogs
```
