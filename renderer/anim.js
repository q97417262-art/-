/*
  anim.js — управление скоростью анимаций интерфейса.
  Работает поверх styles.css: даже если старый CSS остался в кэше,
  этот файл его перебивает (JS-анимация + !important-стили).

  ── НАСТРОЙКА СКОРОСТИ ──────────────────────────────────────────
  Меняй только эти два числа:
*/
const RING_SECONDS_PER_TURN = 10;   // сколько секунд на ОДИН оборот кольца
const GLOW_SECONDS_PER_PASS = 50;  // сколько секунд облако сверху идёт слева-направо
// ────────────────────────────────────────────────────────────────

// 1. Глушим CSS-анимацию кольца и облака (!important перебивает кэш)
function injectOverrides() {
  const style = document.createElement('style');
  style.id = 'anim-overrides';
  style.textContent = `
    .empty-ring {
      animation: none !important;
    }
    body::before {
      animation: glowDriftSlow ${GLOW_SECONDS_PER_PASS}s ease-in-out infinite alternate !important;
    }
    @keyframes glowDriftSlow {
      0%   { transform: translateX(-60%) translateY(-10px) scale(0.99); }
      50%  { transform: translateX(-50%) translateY(10px) scale(1.05); }
      100% { transform: translateX(-40%) translateY(-10px) scale(0.99); }
    }
  `;
  document.head.appendChild(style);
}

// 2. Крутим кольцо сами через requestAnimationFrame.
//    Скорость считается от реального времени, поэтому она одинакова
//    на любом мониторе (60 / 120 / 144 Гц) и не зависит от CSS.
function startRingSpin() {
  const degPerMs = 360 / (RING_SECONDS_PER_TURN * 1000);
  let startTime = null;

  function frame(now) {
    if (startTime === null) startTime = now;
    const angle = ((now - startTime) * degPerMs) % 360;

    const rings = document.querySelectorAll('.empty-ring');
    for (const ring of rings) {
      // Пульсацию свечения тоже делаем сами — медленно и синхронно
      const breathe = (Math.sin((now - startTime) / 1000 * 0.12) + 1) / 2; // 0..1
      ring.style.animation = 'none';
      ring.style.transform = `rotate(${angle}deg) translateZ(0)`;
      ring.style.opacity = (0.8 + breathe * 0.2).toFixed(3);
      ring.style.boxShadow = `0 0 ${(12 + breathe * 14).toFixed(1)}px var(--accent-soft)`;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function initAnimations() {
  injectOverrides();
  startRingSpin();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAnimations);
} else {
  initAnimations();
}
