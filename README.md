# Troop Transport Simulator

A 3D military logistics game, inspired by Euro Truck Simulator. You fly a
CH-47-style tandem-rotor transport, picking up infantry, casualties, pallets
and sling loads, and delivering them across a procedurally generated warzone,
from the safe rear bases to outposts on the front line and landing zones
behind enemy lines. You can also take a Humvee out on road convoy jobs.

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
2. **Load up.** Land near the green smoke and lower the ramp (`R`). The crew
   chief waves the load aboard from the ramp, and everyone walks around the
   aircraft to line up behind it instead of cutting through the fuselage. Troops file up the aisle, sit
   on the red webbing seats and buckle in. Litter teams carry casualties up
   the ramp, lift the litters onto stanchions (two tiers), strap them down
   and sit beside them. Pallet crews push pallets in on a pallet jack, park
   the jack by their seat, ratchet a strap down at each corner and sit.
   Everything stays visible in the cabin, and unloading plays it all in
   reverse. Every passenger adds real mass to the aircraft. For sling loads, hover with the hook over the load,
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

### The aircraft

The cockpit sits on the same deck as the cabin, one step up, with two
armoured pilot seats, cyclics, collectives and pedals, five multifunction
displays under a glareshield, a centre pedestal, an overhead console and a
companionway back to the cabin. From the pilot's seat (cockpit camera) you
can look back over your shoulder into the cabin. The windshield, chin
windows, side windows and cabin windows are real glass, so you can see in
and out. A door gunner sits at the right forward door and a window gunner at
the left escape window, each on an M240, and the co-pilot flies beside you.
The gunners engage enemy infantry inside their arc (about 70° either side
of their opening, out to 550 m) with short bursts. They are support, not a
weapon system: kills are occasional, get rarer with range, speed and
altitude, and they call them out on the radio. Every kill counts against
the enemy in that sector's battle.

## The Humvee

A Humvee waits at the main base motor pool. Land within 140 m of it and press
`G` to get out of the helicopter and into the truck; press `G` again, stopped
within 140 m of the helicopter, to switch back.

Terminals also list **road jobs** (🚙 ROAD; helicopter jobs are tagged
🚁 AIR). These include fireteam transport, supply runs, casualty evacuation
and escort runs between sites on the road network. They work like the
helicopter jobs: drive to the pickup, open the doors (`R`) and wait while
everyone boards, then drive to the destination and open the doors again to
unload. The Humvee has an open cargo bed, so you can watch the load ride:
troops on the bench seats, casualties on a two-tier litter rack, or a
strapped-down pallet. The time limit is set from the route length by road at convoy speed,
not the straight-line distance, so a job that is 3 km by air can be 5 km by
road with more time to match. Pay scales with road distance and risk.

The truck has 4-wheel drive with independent suspension. Roads are graded
and grip better than grass, and bridges have guard rails. Deep water stalls
the engine. If you roll it or get stuck, `T` calls a recovery truck ($400)
that puts you back on the nearest road.

The war doesn't stop for the Humvee. Drive near the front line and the
battles load in around you just as they do for the helicopter: trenches,
infantry, armour, artillery and air strikes. Enemy riflemen and machine
gunners shoot at your vehicle, APCs hose it, RPG teams and tanks go for it
(a moving Humvee is much harder to hit than a parked one), and mortars and
shellfire land around you. MANPADS only go after aircraft. Hits and hard
crashes wear down the hull; if it reaches zero the Humvee is knocked out,
the contract fails, and a replacement waits at the motor pool for a $2,500
deductible.

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

**Humvee** (`G` to switch vehicles):

| Key | Action |
| --- | --- |
| `W` | Accelerate |
| `S` | Brake, then reverse when stopped |
| `A` / `D` | Steer |
| `Space` | Handbrake (parks the truck when slow) |
| `R` | Open / close doors (load and unload) |
| `H` | Horn |
| `T` | Call recovery ($400) |
| `C` | Camera: chase / driver's seat |

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

Roads link everything. Supply traffic of cargo trucks, fuel tankers, HMMWVs
and MRAPs drives the whole network in convoys. They keep to the right-hand
lane, steer smoothly through bends and junctions, slow for curves and keep
their distance. They brake for your Humvee, your landed helicopter and each
other, sound their horns if you block them for too long, and turn around
inside bases before heading out again. They are solid, so drive around them.

The network is laid out like a real one:

- Every base, FOB and outpost faces its connections, with a gated entry
  control point (guard towers, T-walls and barriers). One access road runs
  in from the gate to the motor pool. Bigger sites can have a back gate,
  with a main street through the site joining the two.
- Supply routes meet at a junction outside each gate. They branch off one
  another at T-junctions with rounded corners, like a tree, instead of all
  fanning out of the base.

There are three kinds of road:

- **Main supply routes** (MSRs) run between the main base and the FOBs. They
  are two-lane asphalt with lane markings, steel lattice power lines, and
  streetlights near the bases.
- **Alternate supply routes** run out to the outposts. They are worn,
  patched asphalt with wooden power poles.
- **Gravel tracks** lead to the towns.

All roads have gravel shoulders and reflector posts. Green route signs give
the destination and distance at each junction. Guard rails, which are solid
to vehicles, run along embankments and the outside of sharp curves. Power
lines span rivers from tall towers on either bank. Now and then a fenced
industrial yard sits beside a road, holding containers, fuel tanks, sheds
and trucks. Near the front there are checkpoints of jersey barriers and
HESCO walls, with burned-out vehicles pushed off the road.

Roads are graded like real ones: they cut through hills and run on
embankments. Where they cross a river or a deep valley they go onto bridges
and viaducts that run from bank to bank, and steep ramps climb to hilltop
bases.

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
  heli/chinookModel.ts  procedural CH-47: lofted hull with see-through glazing, cockpit, cabin, crew stations
  vehicles/humvee.ts drivable Humvee: suspension, tires, drivetrain, model
  vehicles/models.ts AI vehicle models (truck, tanker, HMMWV, MRAP) with animated wheels
  game/traffic.ts    AI supply traffic: routing, steering, following, braking
  game/missions.ts   contracts, pay, mission phases, payouts
  game/cargo.ts      boarding: troops, litter teams and pallet crews loading, securing and riding in the cabin
  game/soldiers.ts   instanced articulated soldier models and their poses (walk, carry, push, strap, sit)
  game/sling.ts      hook, rope constraint, slung-load physics
  game/threats.ts    enemy fire, missiles, flares, mortars, ambient battle
  battle/            campaign sectors, materialized battles, trenches, AI aircraft
  game/career.ts     ranks, upgrades, save data
  world/             terrain, front line, sites, towns, props, roads/bridges, roadside, forests, sky
  fx/                particles (dust, smoke, fire), tracers, explosions
  audio.ts           synthesized rotor, turbine, wind and effects audio
  ui/                HUD, minimap and theater map, terminal and dialogs
```
