/**
 * tone.js — a tab-audio source for automated tests.
 *
 * tabCapture needs a tab that actually plays audio. Using an extension page for
 * that keeps the test self-contained: no local HTTP server, no host permission
 * for a third-party origin. The signal mirrors the fake-microphone WAV
 * (runs/fake-audio/speechlike-*.wav) so that mic and tab assets are comparable:
 * sawtooth 165 Hz, AM 4.5 Hz, 2 s of silence every 5 s.
 *
 * The page also shows a wall clock so a screenshot documents when it ran.
 */
const $ = (id) => document.getElementById(id);
let ac = null;

async function start() {
  if (ac) return;
  ac = new AudioContext();
  const osc = ac.createOscillator();
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  const amBias = ac.createConstantSource();
  const gate = ac.createGain();
  const out = ac.createGain();

  osc.type = 'sawtooth'; osc.frequency.value = 165;
  lfo.type = 'sine'; lfo.frequency.value = 4.5; lfoGain.gain.value = 0.35;
  amBias.offset.value = 0.65;
  out.gain.value = 0.25;

  // AM: (0.65 + 0.35·sin) applied as gate gain.
  gate.gain.value = 0;
  lfo.connect(lfoGain).connect(gate.gain);
  amBias.connect(gate.gain);
  osc.connect(gate).connect(out).connect(ac.destination);

  osc.start(); lfo.start(); amBias.start();

  // 3 s on, 2 s off — scheduled on the audio clock, not setTimeout.
  const period = 5, on = 3;
  const schedule = () => {
    const now = ac.currentTime;
    const cycle = Math.floor(now / period);
    for (let k = cycle; k < cycle + 4; k++) {
      const t = k * period;
      out.gain.setValueAtTime(0.25, Math.max(t, now));
      out.gain.setValueAtTime(0, Math.max(t + on, now));
    }
  };
  schedule();
  setInterval(schedule, 5000);

  $('state').textContent = `играет: AudioContext ${ac.sampleRate} Гц`;
  if (ac.state !== 'running') await ac.resume();
}

function stop() {
  if (!ac) return;
  ac.close(); ac = null;
  $('state').textContent = 'остановлено';
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('ru-RU'); }, 250);

// Autoplay: tests launch Chrome with --autoplay-policy=no-user-gesture-required.
// Without that flag the context stays suspended until the user clicks Play.
start().catch((e) => { $('state').textContent = `не удалось запустить: ${e.message}`; });
