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
   and release it. Every base, FOB and outpost has dedicated areas, and each
   load goes to its own: casualties to the field hospital (a permanent
   building at the main base, a medical tent at FOBs, an aid tent at
   outposts), ammunition to the sandbagged ammo point, other supplies to the
   supply yard, officers to the HQ and troops to the barracks. As you come
   in, the receiving area sends people out to wait at the edge of the
   landing zone: medics join each litter team, porters help push each
   pallet, and an orderly salutes the officers and leads them in. Pallets
   are stacked in their storage area and stay there. On road jobs they walk
   in through the gate. Pickups work the other way round: if there's time
   before you arrive, troops, litter teams and pallet crews walk out of
   their facility to the pickup point.
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
Each M240 swivels on its pintle mount: the gunner traverses it onto the
enemy he is engaging and only opens fire once the barrel is on target. The
gun shudders and flashes with each burst. The gunner swivels on his seat to
follow it, with both hands on the grips, head down behind the gun. With
nothing to shoot at, he sweeps the ground slowly.

## Soldiers

Every soldier, from your passengers to base helpers to frontline infantry,
uses the same articulated model: helmet with NVG mount, plate carrier with
pouches and radio, pack, knee pads, gloves and a rifle with optic and sling.
Their hands are placed on the rifle by IK, so the weapon is really held.
How they carry it depends on what they are doing:

- slung across the chest when relaxed on base
- on the back while working (digging, carrying litters, strapping cargo)
- at the low ready while moving to and from the aircraft
- shouldered with a cheek weld when aiming

Idle soldiers breathe, shift their weight and look around, each on their own
rhythm, and walking uses heel-to-toe steps with hip sway. In a hostile LZ
(high-risk sites and enemy-side drops) the waiting squad kneels in a
perimeter facing outward, weapons up. Troops you drop there bound off the
ramp in a crouched combat walk and set up a kneeling security perimeter
facing away from the aircraft. When the aircraft takes fire (hits, rounds
cracking past or shells landing close), everyone loading or unloading
hurries. Troops sprint, litter teams and loaders move hunched at a run, and
strapping and lifting go roughly twice as fast. They stay hurried for a
while after the shooting stops. Soldiers close to the camera get full detail;
distant ones switch to a simpler model.

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
| Mouse, wheel | Look around, zoom. In fullscreen the cursor is hidden and the mouse just moves the camera; windowed, drag to look |
| Hold left `Alt` | Show the cursor (fullscreen) |
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

**Graphics** (pause menu) cycles Auto / High / Medium / Low, saved in the
browser. High is the full look. Medium renders at up to 1× pixel ratio, with
a smaller, harder-edged shadow map over a smaller area, thinner and shorter
grass, crops only within 70 m, and trees, buildings and small props swapping
to their far versions or dropping out sooner. Low also renders at 0.75×,
turns off antialiasing, removes the crop plants (the field rows stay in the
ground) and keeps shadows only for the aircraft, vehicles and people near
you. Auto picks a level from the GPU name (integrated Intel and software
renderers start at Low; Iris Xe, Radeon integrated graphics and Apple
M-series at Medium; dedicated GPUs at High). While playing it lowers the
render resolution (to 70%) when the frame rate drops below 45 and raises it
again with headroom. If it stays slow, it drops one level. Antialiasing
changes apply the next time the game loads.

Gamepad: the left stick is collective and yaw, the right stick is cyclic, and
the triggers also move the collective. A = ramp, B = hook, X = engine,
Y = camera, LB = flares, RB = SAS, Start = terminal.

## The world

Each career has a seed that generates a 14.4 × 14.4 km theater (about 12.6 km
across inside the mountains): rolling hills, rivers crossed by bridges, mountains around the edges, and a winding **front
line** (friendly to the west, enemy to the east) scarred with craters,
burning wrecks, artillery and tracer fire. The ground flattens out near the
front so battles happen on sensible terrain.

Rivers meander and branch through broad, gentle valleys. Each has a
channel about 40–60 m wide and 3–4 m deep, low banks with a strip of sand
and pebbles, a grassy floodplain, and valley sides that start at a couple of
degrees and only slowly steepen into the hills. The water is shaded per
pixel:

- ripples that drift downstream with the current
- sky reflections that strengthen at low angles, and sun glints
- the riverbed showing through the shallows, darker green-brown water in the channel
- foam streaks along the banks

Places include:

- **Main operating base**: hangars, fuel farm, upgrades.
- **FOBs** (about six): fuel, repair and flares.
- **Combat outposts** (about a dozen) near the front.
- **Landing zones** (about twenty): open fields, some behind enemy lines.
- **Cities** (three: two behind our lines, one behind theirs), each about a
  kilometre across, on a street grid:
  - a central square with a war memorial, a fountain and kiosks, ringed by
    Stalin-era blocks, shops with awnings and offices, with a cathedral nearby
  - panel-block estates (nine-storey slabs and sixteen-storey towers) with
    playgrounds, garages, schools and parks
  - five-storey blocks and petrol stations further out
  - private houses behind board fences on the edges
  - an industrial quarter of factories, warehouses, chimneys and water towers
  - avenues lined with lime trees, and parked cars along the streets
- **Towns**: the same plan on a smaller scale. Contested towns straddle the
  front, ruined and fought over.
- **Villages and farming communities** (about thirty, several on each city's
  outskirts):
  - houses along the street behind board fences, with gardens, fruit trees
    and sheds
  - a shop and a bus stop, and a chapel in the bigger ones
  - farmyards at each end with a barn, a machinery shed and a tractor

Around every town and village lies its farmland, a grid of 95 × 60 m plots:

- **Crops:** wheat, barley, rapeseed, sunflowers, beet and potatoes, ploughed
  earth, and hay meadows with round bales. Close to the camera the crops
  stand in real rows that sway in the wind and flatten under the rotor wash.
  Each plot's ground is painted the colour of its crop, and the plants grow
  up out of it gradually over the last stretch of their 110 m range. Coming
  in to land, a field keeps its colour while its crops rise, with no visible
  pop. Grass fades out the same way as you climb.
- **Clearance:** no plot reaches into a base, outpost or landing zone.
- **Pastures:** fenced with post and rail, with cattle grazing.
- **Farmsteads:** a farmhouse, barn, machinery shed, silos and haystacks.
- **Field work:** tractors plough, spray and mow, and combines harvest. Each
  runs up and down its plot in passes the width of its implement, trailing
  dust and chaff. Farms near the front lie idle.

Roads link everything. Supply traffic of cargo trucks, fuel tankers, HMMWVs
and MRAPs drives the whole network in convoys. They keep to the right-hand
lane, steer smoothly through bends and junctions, slow for curves and keep
their distance. They brake for your Humvee, your landed helicopter and each
other, sound their horns if you block them for too long, and turn around
inside bases before heading out again. They are solid, so drive around them.

Civilian traffic fills the roads and streets around you: saloons,
hatchbacks, vans, buses, lorries and the odd tractor. Their roads are the
country roads that link each town and village to its neighbours (cities to
several), which keep well clear of the bases. Cars drive the street grids
and those roads between the settlements, and never use the supply routes to
the bases. They never go within about 1.5 km of the front or into contested
towns, and turn round where a road heads into danger. About forty are kept
around the camera at a time.

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
bases. Bridges are always paved: a dirt track gets an asphalt deck and short
asphalt approaches where it crosses.

**Collisions** follow each structure's real shape, not a box around it.
Every building and prop keeps the solid parts it is modelled from (walls,
pillars, roofs, tanks, poles) in its own turned frame: boxes, upright
cylinders for round parts, a half-cylinder for hangars and a ridge for
gables and tents. Streets and pavements beside a turned building stay open,
you can drive under a petrol-station canopy, and a rotor only strikes what
is actually there. Parked cars, kiosks, bus stops, street lamps, sign posts,
street trees, sandbags, crates, barrels, wrecks, rocks, hay bales and parked
military vehicles are solid. Rubble, slabs, plazas, delineators, fence and
guard-rail posts, and livestock can be driven over or through. Forest trees
block at the trunk below the crown and at the crown above it, so vehicles
pass under the branches.

### The look

A sunny summer day in eastern Europe:

- **Light and grade:** warm sun, a blue skylight, and ACES tone mapping with
  a light grade on top (a little more saturation, an S-curve for contrast).
- **Sky and haze:** fair-weather cumulus drift across a deep blue sky. The
  haze is a height fog, thick in the valleys and thin over the peaks, and it
  warms toward the sun. Distant ridges read as layers of blue rather than a
  white wall. Two rings of far mountain ranges sit on the horizon beyond the
  map.
- **Land:** meadow greens, drier rises and dark forest floor, with rock and
  alpine grass on the heights. Around each village is a patchwork of wheat,
  barley, young crops, rapeseed, sunflowers and ploughed earth, drawn per
  pixel with crop rows and hedgerow margins. Bases are packed earth and worn
  grass.
- **Grass:** tufts with the odd wildflower carpet the ground around the
  camera. They take the colour of the land under them, sway in the wind, and
  are blown flat by rotor downwash when you come in low.
- **Buildings and props:** each part knows what it's made of, and a shader
  draws the surface detail with a small bump and darkening toward the ground.
  Surfaces include plaster, brick, clay tiles, corrugated sheet, boards,
  concrete panels, canvas, sandbags, HESCO mesh, rock, foliage and bark.
  Windows reflect the sky. Villages have pastel rendered cottages with framed
  windows, shutters and porches, red-brick houses, five-storey panel blocks
  with balconies, timber barns, and an onion-domed church.
- **Trees:** tiered spruce, lumpy broadleaf crowns and white birches.

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

## Performance

The theater is big, so most of it is drawn cheaply or not at all:

- **Terrain** is 81 tiles of 1.6 km, each picking one of five levels of
  detail by distance (full 12.5 m grid up close, 200 m far out), with skirts
  hiding the seams. Off-screen tiles are culled, including from the shadow
  pass.
- **Shadows**: the instanced world chunks don't cast. Invisible copies of the
  trees and buildings within 170 m (fewer on lower settings) draw only into
  the shadow map, rebuilt as you move.
- **Forests** are in 1.2 km chunks: full trees within about 1 km, a single
  five-sided stand-in per tree (one draw call per chunk) out to the fog, and
  nothing beyond.
- **Props** are instanced per prototype per cell (0.8 km for small props,
  1.2 km for buildings with a far version, 2.4 km otherwise) and hidden by size
  class: fence posts and delineators go first, buildings and pylons stay to
  the fog. Buildings switch to a simplified version (plain window panes)
  beyond 1.2 km.
- **Grass** is one instanced mesh refilled from cached 16 m cells as the
  camera moves, within 120 m, and hidden above 170 m. Long roadside meshes (rails, fences, wires) are split per cell.
- **Big buildings** draw their windows in the facade shader (a box, not
  hundreds of window parts).
- **Crops** are instanced 4 m row segments within 110 m of the camera, with a
  sparser version beyond 50 m. Further out, the ground shader draws the rows.
- **Traffic** checks only its neighbours (a 25 m grid), skips obstacle checks
  for cars kilometres away, swaps to a single merged mesh beyond 220 m and
  disappears past
  4 km. Static parts of the helicopter and Humvee are merged by material.
- The camera's far plane stops just past the fog.

World generation logs its phase timings to the console.

## Code map

```
src/
  main.ts            menu, launching a career
  game.ts            game loop, glue between systems, prompts, crash/respawn
  graphics.ts        graphics presets, GPU detection, Auto's resolution scaler
  heli/flight.ts     flight model (thrust, drag, control laws, ground contact)
  heli/heli.ts       aircraft entity: damage, ramp, rotors, collisions
  heli/chinookModel.ts  procedural CH-47: lofted hull with see-through glazing, cockpit, cabin, crew stations
  vehicles/humvee.ts drivable Humvee: suspension, tires, drivetrain, model
  vehicles/models.ts AI vehicle models (truck, tanker, HMMWV, MRAP) with animated wheels
  game/traffic.ts    AI supply convoys and civilian traffic: routing, steering, following, braking
  game/farmwork.ts   tractors and combines working the fields
  game/missions.ts   contracts, pay, mission phases, payouts
  game/cargo.ts      boarding: troops, litter teams and pallet crews loading, securing and riding in the cabin
  game/soldiers.ts   instanced articulated soldier models and their poses (gait, idle, rifle carries with arm IK, kneel/prone/aim, tasks), with LOD
  game/sling.ts      hook, rope constraint, slung-load physics
  game/threats.ts    enemy fire, missiles, flares, mortars, ambient battle
  battle/            campaign sectors, materialized battles, trenches, AI aircraft
  game/career.ts     ranks, upgrades, save data
  world/             terrain, front line, sites, towns/cities/villages + buildings, farms, props + surfaces, roads/bridges, roadside, forests, grass + crops, rivers, sky + look (fog, grade)
  fx/                particles (dust, smoke, fire), tracers, explosions
  audio.ts           synthesized rotor, turbine, wind and effects audio
  ui/                HUD, minimap and theater map, terminal and dialogs
  world/colliders.ts structure collisions: a grid of bounding boxes, each with its prototype's solid parts
  world/lod.ts       distance culling and per-cell splitting of world chunks
  world/shadows.ts   near-only shadow casters for the instanced trees and buildings
```
