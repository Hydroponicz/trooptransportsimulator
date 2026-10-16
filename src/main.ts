import { Game } from './game';
import { Career } from './game/career';
import { enterFullscreen, toggleFullscreen } from './fullscreen';
import { startPadNav } from './ui/padnav';

const menu = document.getElementById('menu')!;
const buttons = document.getElementById('menu-buttons')!;
const status = document.getElementById('menu-status')!;
const loading = document.getElementById('loading')!;
const loadingMsg = document.getElementById('loading-msg')!;
const app = document.getElementById('app')!;

let game: Game | null = null;

// While flying, an accidental Ctrl+W (descend + pitch) asks before closing the tab.
window.addEventListener('beforeunload', (e) => {
  if (!game || !menu.classList.contains('hidden')) return;
  game.career.save();
  e.preventDefault();
  // A non-empty value is required by some browsers to actually show the prompt.
  e.returnValue = 'Leave the game? Unsaved flight progress will be lost.';
  return e.returnValue;
});

function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function showMenu() {
  menu.classList.remove('hidden');
  const saved = Career.load();
  buttons.innerHTML = '';
  const mk = (label: string, primary: boolean, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = fn;
    buttons.appendChild(b);
  };
  if (!webglOk()) {
    status.textContent = 'WebGL is not available in this browser — the game cannot run.';
    return;
  }
  if (saved) {
    mk(`Continue career — ${saved.rankName}, $${saved.data.money.toLocaleString()}`, true, () => launch(saved));
    mk('New career (new theater)', false, () => {
      if (confirm('Start over? Your current career will be replaced.')) launch(Career.fresh());
    });
  } else {
    mk('Start career', true, () => launch(Career.fresh()));
  }
  mk(document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen', false, () => void toggleFullscreen().then(showMenu));
  const seedBtn = document.createElement('button');
  seedBtn.textContent = 'Play a specific seed…';
  seedBtn.onclick = () => {
    const s = prompt('World seed (number):');
    if (s && /^\d+$/.test(s.trim())) launch(Career.fresh(Number(s.trim())));
  };
  buttons.appendChild(seedBtn);
  status.textContent = saved ? `Theater seed ${saved.data.seed}` : 'Every career generates a new procedural theater of operations.';
}

function launch(career: Career) {
  // Fullscreen + keyboard lock so Ctrl+W / Ctrl+Q (descend + pitch/yaw) reach
  // the game instead of closing the browser. Called synchronously from the click.
  void enterFullscreen();
  career.save();
  menu.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingMsg.textContent = 'Generating theater…';
  // Let the loading screen paint before the heavy generation work.
  setTimeout(() => {
    try {
      if (game) {
        game.stop();
        game.renderer.dispose();
        game.renderer.domElement.remove();
      }
      game = new Game(career, app, (m) => (loadingMsg.textContent = m));
      game.onQuit = () => {
        game?.stop();
        game?.hud.show(false);
        showMenu();
      };
      loading.classList.add('hidden');
      game.start();
      (window as unknown as { game: Game }).game = game;
    } catch (e) {
      console.error(e);
      loadingMsg.textContent = `Failed to start: ${(e as Error).message}`;
    }
  }, 50);
}

showMenu();

startPadNav();
