import type { Game } from '../game';
import type { Site } from '../world/sites';
import { SITE_KIND_LABEL } from '../world/sites';
import { fmtDist, fmtMoney, fmtTime } from '../util/math';
import { RANKS, UPGRADES } from '../game/career';
import type { Contract, Payout } from '../game/missions';

type Tab = 'contracts' | 'services' | 'hangar' | 'front' | 'career';

export const PRICES = { fuelPerKg: 1.2, repairPerHp: 90, flare: 60 };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Terminal {
  private el = document.getElementById('terminal')!;
  private dlg = document.getElementById('dialog')!;
  private tab: Tab = 'contracts';
  private site: Site | null = null;
  isOpen = false;
  dialogOpen = false;

  constructor(private game: Game) {
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.dlg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const fn = this.dialogActions.get(b.dataset.act ?? '');
      if (fn) fn();
    });
  }

  open(site: Site) {
    this.site = site;
    this.isOpen = true;
    if (this.tab === 'hangar' && !site.services.hangar) this.tab = 'contracts';
    this.el.classList.remove('hidden');
    this.render();
  }

  close() {
    this.isOpen = false;
    this.el.classList.add('hidden');
  }

  private onClick(e: Event) {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const g = this.game;
    g.audio.click();
    const act = b.dataset.act;
    if (act === 'tab') {
      this.tab = b.dataset.tab as Tab;
    } else if (act === 'close') {
      this.close();
      return;
    } else if (act === 'accept') {
      const c = this.contracts().find((x) => x.id === Number(b.dataset.id));
      if (c) {
        g.missions.accept(c);
        g.audio.beepOk();
        this.close();
        if (c.mode === 'air' && g.mode === 'drive') g.toast('Helicopter job — get back in the helicopter [G] to fly it', 'info');
        else if (c.mode === 'ground' && g.mode === 'fly') g.toast('Road job — get in the Humvee [G] to drive it', 'info');
        return;
      }
    } else if (act === 'abandon') {
      const m = g.missions.active;
      if (m) {
        const fee = Math.round(m.c.pay * 0.1);
        g.career.data.money = Math.max(0, g.career.data.money - fee);
        g.missions.abandon();
        g.toast(`Cancellation fee ${fmtMoney(fee)}`, 'bad');
      }
    } else if (act === 'refuel') {
      const fm = g.heli.fm;
      const need = fm.fuelCapacity - fm.fuel;
      const afford = Math.min(need, g.career.data.money / PRICES.fuelPerKg);
      if (afford > 1) {
        g.career.data.money -= Math.ceil(afford * PRICES.fuelPerKg);
        fm.fuel += afford;
        g.audio.cash();
      }
    } else if (act === 'repair') {
      const need = 100 - g.heli.hp;
      const afford = Math.min(need, g.career.data.money / PRICES.repairPerHp);
      if (afford > 0.5) {
        g.career.data.money -= Math.ceil(afford * PRICES.repairPerHp);
        g.heli.hp += afford;
        g.audio.cash();
      }
    } else if (act === 'flares') {
      const need = g.heli.maxFlares - g.heli.flares;
      const n = Math.min(need, Math.floor(g.career.data.money / PRICES.flare));
      if (n > 0) {
        g.career.data.money -= n * PRICES.flare;
        g.heli.flares += n;
        g.audio.cash();
      }
    } else if (act === 'upgrade') {
      const id = b.dataset.id as keyof typeof g.career.data.upgrades;
      const def = UPGRADES.find((u) => u.id === id)!;
      const lvl = g.career.data.upgrades[id];
      const next = def.levels[lvl];
      if (next && g.career.spend(next.cost)) {
        g.career.data.upgrades[id] = lvl + 1;
        g.applyUpgrades();
        g.audio.cash();
        g.toast(`${def.name} installed`, 'good');
      }
    }
    g.career.save();
    this.render();
  }

  private contracts(): Contract[] {
    if (!this.site) return [];
    // Jobs for the vehicle you're in come first.
    const mine = this.game.mode === 'drive' ? 'ground' : 'air';
    return [...this.game.missions.board(this.site, this.game.career.rank, this.game.time)].sort((a, b) => Number(b.mode === mine) - Number(a.mode === mine));
  }

  render() {
    const g = this.game;
    const s = this.site!;
    const tabs: [Tab, string][] = [['contracts', 'Contracts'], ['services', 'Services']];
    if (s.services.hangar) tabs.push(['hangar', 'Hangar']);
    tabs.push(['front', 'Front'], ['career', 'Career']);
    let body = '';
    if (this.tab === 'contracts') body = this.renderContracts();
    else if (this.tab === 'services') body = this.renderServices();
    else if (this.tab === 'hangar') body = this.renderHangar();
    else if (this.tab === 'front') body = this.renderFront();
    else body = this.renderCareer();
    this.el.innerHTML = `
      <div class="term">
        <header>
          <div><h2>${esc(s.name)}</h2><div class="sub">${SITE_KIND_LABEL[s.kind]} · ${s.enemySide ? 'ENEMY TERRITORY' : `${fmtDist(Math.abs(s.frontDist))} from the front`}</div></div>
          <div class="money">${fmtMoney(g.career.data.money)}</div>
        </header>
        <nav>${tabs.map(([id, l]) => `<button data-act="tab" data-tab="${id}" class="${this.tab === id ? 'on' : ''}">${l}</button>`).join('')}</nav>
        <div class="body">${body}</div>
        <footer><span>${RANKS[g.career.rank].name} · ${g.career.data.xp} XP</span><button data-act="close">Close [Tab]</button></footer>
      </div>`;
  }

  private renderContracts(): string {
    const g = this.game;
    let html = '';
    const m = g.missions.active;
    if (m) {
      html += `<div class="active-card"><b>Active:</b> ${m.c.type.icon} ${esc(m.c.type.name)} — ${esc(m.c.from.name)} → ${esc(m.c.to.name)} · ${fmtMoney(m.c.pay)}
        <div style="margin-top:8px;display:flex;gap:10px;align-items:center"><span style="font-size:12px;color:#a9b5a3">One contract at a time. Abandoning costs 10% of the contract value.</span>
        <button data-act="abandon">Abandon (${fmtMoney(Math.round(m.c.pay * 0.1))})</button></div></div>`;
    }
    const rank = g.career.rank;
    const list = this.contracts();
    if (!list.length) html += '<p>No work available here right now. Try another base.</p>';
    for (const c of list) {
      const locked = c.type.minRank > rank;
      const remote = c.from !== this.site;
      const mass = c.mass >= 1000 ? `${(c.mass / 1000).toFixed(1)} t` : `${c.mass} kg`;
      const what = c.type.kind === 'sling' ? `External load ${mass}` : `${c.count} × ${c.type.kind === 'troops' ? 'pax' : c.type.kind === 'casualties' ? 'litters' : 'pallets'} · ${mass}`;
      html += `
        <div class="job ${locked ? 'locked' : ''}">
          <div class="ico">${c.type.icon}</div>
          <div>
            <div class="name">${esc(c.type.name)}${c.mode === 'ground' ? ' <span class="road">🚙 ROAD</span>' : ' <span class="air">🚁 AIR</span>'}${c.type.urgent ? ' <span class="risk r3">URGENT</span>' : ''}</div>
            <div class="route">${remote ? `Pickup at <b>${esc(c.from.name)}</b> → ` : ''}${esc(c.to.name)} <span style="color:#8e9a89">(${SITE_KIND_LABEL[c.to.kind]})</span></div>
            <div class="meta"><span>${c.mode === 'ground' ? `${fmtDist(c.route ?? c.distance)} by road` : fmtDist(c.distance)}</span><span>${what}</span><span>⏱ ${fmtTime(c.timeLimit)}</span>
              <span class="risk ${c.risk >= 3 ? 'r3' : ''}">${'●'.repeat(c.risk)}${'○'.repeat(3 - c.risk)}</span></div>
            <div class="desc">${esc(c.type.desc)}</div>
          </div>
          <div class="pay"><b>${fmtMoney(c.pay)}</b>
            ${locked ? `<button disabled>Requires ${RANKS[c.type.minRank].short}</button>` : `<button class="primary" data-act="accept" data-id="${c.id}" ${m ? 'disabled' : ''}>Accept</button>`}
          </div>
        </div>`;
    }
    return html;
  }

  private renderServices(): string {
    const g = this.game;
    const s = this.site!;
    const fm = g.heli.fm;
    const needFuel = Math.max(0, fm.fuelCapacity - fm.fuel);
    const needHp = Math.max(0, 100 - g.heli.hp);
    const needFl = g.heli.maxFlares - g.heli.flares;
    const row = (t: string, d: string, btn: string) => `<div class="svc"><div><div class="t">${t}</div><div class="d">${d}</div></div>${btn}</div>`;
    let html = '';
    html += row(
      'Refuel',
      `${fm.fuel.toFixed(0)} / ${fm.fuelCapacity.toFixed(0)} kg JP-8`,
      s.services.fuel
        ? `<button data-act="refuel" ${needFuel < 1 ? 'disabled' : ''}>Fill up ${fmtMoney(Math.ceil(needFuel * PRICES.fuelPerKg))}</button>`
        : '<button disabled>No fuel here</button>',
    );
    html += row(
      'Airframe repair',
      `Hull integrity ${g.heli.hp.toFixed(0)}%`,
      s.services.repair
        ? `<button data-act="repair" ${needHp < 0.5 ? 'disabled' : ''}>Repair ${fmtMoney(Math.ceil(needHp * PRICES.repairPerHp))}</button>`
        : '<button disabled>No maintenance crew</button>',
    );
    html += row(
      'Countermeasures',
      `${g.heli.flares} / ${g.heli.maxFlares} flares`,
      s.services.flares
        ? `<button data-act="flares" ${needFl <= 0 ? 'disabled' : ''}>Restock ${fmtMoney(needFl * PRICES.flare)}</button>`
        : '<button disabled>Not stocked</button>',
    );
    return html;
  }

  private renderHangar(): string {
    const g = this.game;
    let html = '<p style="color:#a9b5a3;margin-top:0">Upgrades are permanent and apply immediately.</p>';
    for (const u of UPGRADES) {
      const lvl = g.career.data.upgrades[u.id];
      const next = u.levels[lvl];
      const pips = u.levels.map((_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      html += `<div class="svc"><div><div class="t">${u.name}<span class="pips">${pips}</span></div>
        <div class="d">${next ? `Next: ${next.desc}` : 'Fully upgraded'}${lvl > 0 ? ` · Current: ${u.levels[lvl - 1].desc}` : ''}</div></div>
        ${next ? `<button data-act="upgrade" data-id="${u.id}" ${g.career.data.money < next.cost ? 'disabled' : ''}>${fmtMoney(next.cost)}</button>` : '<button disabled>MAX</button>'}</div>`;
    }
    return html;
  }

  private renderFront(): string {
    const camp = this.game.battle.campaign;
    const here = this.site ? camp.sectorAt(this.site.z) : null;
    const bar = (c: number) => {
      const share = Math.round(((c + 1) / 2) * 100);
      return `<div style="display:flex;height:8px;width:120px;border-radius:2px;overflow:hidden"><div style="width:${share}%;background:#5aa0ff"></div><div style="flex:1;background:#ff5a46"></div></div>`;
    };
    const rows = camp.sectors
      .map((s) => {
        const c = camp.control(s);
        const pct = (n: number) => Math.round(n * 100) + '%';
        return `<tr style="${s === here ? 'background:rgba(242,233,166,0.08)' : ''}">
          <td><b>${s.name}</b>${s === here ? ' ◂ here' : ''}</td><td>${bar(c)}</td><td>${esc(camp.status(s))}</td>
          <td>${Math.floor(s.inf.blue)} / ${Math.floor(s.inf.red)}</td><td>${Math.floor(s.armor.blue)} / ${Math.floor(s.armor.red)}</td>
          <td>${pct(s.fort.blue)} / ${pct(s.fort.red)}</td><td>${s.ammo.blue.toFixed(1)}×</td><td>${s.arty.blue.toFixed(1)}</td></tr>`;
      })
      .join('');
    return `<p style="color:#a9b5a3;margin-top:0">Sectors run north (A) to south (J) along the front. Friendly / enemy numbers.
      Deliveries to outposts and landing zones near the line change these: troops reinforce, ammo raises firepower,
      supplies build fortifications, howitzers add artillery, vehicles add armor.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;font-family:var(--mono)">
      <tr style="color:#9dff9d;text-align:left"><th>Sector</th><th>Control</th><th>Status</th><th>Infantry</th><th>Armor</th><th>Fortified</th><th>Ammo</th><th>Arty</th></tr>
      ${rows}</table>`;
  }

  private renderCareer(): string {
    const st = this.game.career.data.stats;
    const c = this.game.career;
    const ranks = RANKS.map((r, i) => `<div style="color:${i <= c.rank ? '#f2e9a6' : '#6b7566'}">${i <= c.rank ? '★' : '☆'} ${r.name} — ${r.xp} XP</div>`).join('');
    return `<div class="stats">
      <div><b>${st.deliveries}</b><span>Contracts completed</span></div>
      <div><b>${fmtMoney(st.earned)}</b><span>Total earned</span></div>
      <div><b>${st.troopsMoved}</b><span>Personnel moved</span></div>
      <div><b>${(st.cargoKg / 1000).toFixed(1)} t</b><span>Cargo moved</span></div>
      <div><b>${st.distanceKm.toFixed(0)} km</b><span>Distance flown</span></div>
      <div><b>${(st.flightTime / 3600).toFixed(1)} h</b><span>Flight hours</span></div>
      <div><b>${st.butterLandings}</b><span>Butter landings</span></div>
      <div><b>${st.crashes}</b><span>Airframes lost</span></div>
    </div><h3 style="color:#9dff9d;font-size:13px;letter-spacing:2px;margin:18px 0 6px">RANKS</h3>${ranks}
    <p style="font-size:12px;color:#8e9a89">World seed ${this.game.career.data.seed}</p>`;
  }

  private dialogActions = new Map<string, () => void>();

  dialog(html: string, actions: Record<string, () => void>) {
    this.dialogActions = new Map(Object.entries(actions));
    this.dlg.innerHTML = `<div class="dlg">${html}</div>`;
    this.dlg.classList.remove('hidden');
    this.dialogOpen = true;
  }

  closeDialog() {
    this.dlg.classList.add('hidden');
    this.dialogOpen = false;
  }

  payout(p: Payout, promoted: string | null, onClose: () => void) {
    const rows = p.lines
      .map((l) => `<tr><td>${esc(l.label)}</td><td class="${l.amount < 0 ? 'neg' : l.amount > 0 && l !== p.lines[0] ? 'pos' : ''}">${l.amount < 0 ? '−' : ''}${fmtMoney(Math.abs(l.amount))}</td></tr>`)
      .join('');
    this.dialog(
      `<h2>Delivery complete</h2>
      <div class="sub">${esc(p.contract.to.name)} · ${fmtTime(p.time)} · cargo ${p.condition}% · +${p.xp} XP</div>
      <table>${rows}<tr class="total"><td>Total</td><td>${fmtMoney(p.total)}</td></tr></table>
      ${promoted ? `<div class="promo">★ PROMOTED — ${esc(promoted)} ★</div>` : ''}
      <div class="actions"><button class="primary" data-act="ok">Continue</button></div>`,
      {
        ok: () => {
          this.closeDialog();
          onClose();
        },
      },
    );
  }
}
