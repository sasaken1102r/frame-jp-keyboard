// Styles for the overlay. They live inside a shadow root, so they cannot leak into Steam's
// keyboard and Steam's styles cannot reach us. Class names are fjk- prefixed anyway.
//
// Look: a dark theme like common smartphone keyboards. High contrast and large glyphs,
// because the panel is small (854 x 239 CSS px) and read through a VR headset.
//
// Geometry of the 854 x 239 key panel (minimal mode):
//   padding 3 px top/bottom, 4 px left/right -> content 846 x 233
//   key rows: 4 x 56 px with 3 px gaps (every page uses the full height)
//   kana page: composition panel 336 px | gap 6 px | flick pad 504 px
//     flick pad columns (weights 1 : 1.35 : 1.35 : 1.35 : 1, 3 px gaps): 80.7 / 109 / 109 / 109 / 80.7 px
//     composition panel: preedit line 30 px, the candidate grid (35 px rows, 4 px gaps: 4 rows), then
//     a 36 px bar with the close button, the update indicator and "Steam ⌨" (32 px tall targets)
//   QWERTY and numbers: full width 846 px; suggestion strip 36 px + gap 3 px, then 4 key rows of
//     46.25 px (3 px gaps)
//   symbols (記号): full width, 4 x 56 px rows (8 symbols per row need the width)

export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; touch-action: none; user-select: none; -webkit-user-select: none; }
[hidden] { display: none !important; }
.fjk-root {
  --bg: #1b1c1f; --key: #3b3e43; --key-edge: #54585f; --side: #2a2c30; --side-edge: #43464c;
  --text: #f1f3f4; --dim: #9aa0a6; --pressed: #5f6368; --accent: #8ab4f8; --accent-text: #0b1b33;
  --pad: 504px;
  position: absolute; inset: 0; display: flex; flex-direction: column; padding: 3px 4px;
  background: var(--bg); color: var(--text);
  font-family: "Noto Sans CJK JP", "Noto Sans JP", "Motiva Sans", sans-serif;
  touch-action: none; overflow: hidden;
}
.fjk-main { flex: 1 1 auto; min-height: 0; display: flex; gap: 6px; }

/* Composition panel (kana page only): preedit on top, candidate grid below. */
.fjk-left {
  position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 4px;
  border-radius: 8px; background: #202124; border: 1px solid #2f3236; padding: 0 4px 4px;
}
.fjk-topline {
  flex: 0 0 30px; height: 30px; min-height: 0; display: flex; align-items: center; gap: 6px; min-width: 0;
  border-bottom: 1px solid #33363b;
}
.fjk-preedit {
  flex: 0 1 auto; max-width: 100%; overflow: hidden; white-space: nowrap;
  display: flex; align-items: center; padding: 0 4px; font-size: 21px; line-height: 1;
}
.fjk-pre { text-decoration: underline; text-decoration-color: var(--dim); text-underline-offset: 4px; }
.fjk-seg {
  background: var(--accent); color: var(--accent-text); border-radius: 3px;
  text-decoration-color: var(--accent-text); padding: 1px 0;
}
.fjk-caret {
  display: inline-block; width: 2px; height: 22px; margin: 0 1px; background: var(--accent);
  animation: fjk-blink 1s steps(1) infinite;
}
@keyframes fjk-blink { 50% { opacity: 0; } }
.fjk-stock {
  flex: 0 0 auto; margin-left: auto; padding: 2px 10px; border-radius: 11px;
  font-size: 13px; color: var(--dim); border: 1px solid var(--side-edge);
}
.fjk-stock.fjk-pressed { background: var(--pressed); color: var(--text); }
/* Close-keyboard button: left end of the kana bar and of the English strip. */
.fjk-close {
  flex: 0 0 44px; width: 44px; height: 30px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: 1px solid var(--side-edge); color: #c7ccd3; background: var(--side);
}
.fjk-close .fjk-icon { width: 26px; height: 26px; }
.fjk-close.fjk-pressed { background: var(--pressed); color: var(--text); }
.fjk-cands {
  position: relative; flex: 1 1 0; min-height: 0; display: flex; flex-wrap: wrap; align-content: flex-start;
  gap: 4px; overflow: hidden;
}
.fjk-cand {
  flex: 0 0 auto; height: 35px; max-width: 100%; display: flex; align-items: center; padding: 0 12px;
  border-radius: 6px; background: #2a2c30; border: 1px solid #3a3d42;
  font-size: 20px; color: var(--text); white-space: nowrap; overflow: hidden;
}
.fjk-cand.fjk-selected { background: #394457; border-color: var(--accent); color: #fff; }
.fjk-cands.fjk-stale .fjk-cand { opacity: 0.4; }
.fjk-cand.fjk-pressed { background: var(--pressed); }
.fjk-placeholder {
  position: absolute; left: 0; right: 0; top: 34px; bottom: 44px; display: flex; align-items: center;
  justify-content: center; padding: 0 16px; text-align: center; font-size: 14px; color: #6f757c;
  pointer-events: none;
}

/* Key pages: the flick pad on the right of the kana page, full width otherwise. */
.fjk-right { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 3px; }
.fjk-split .fjk-right { flex: 0 0 var(--pad); width: var(--pad); }
.fjk-pages { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }

/* Strip above the full-width pages: close | English word and suggestions | update, Steam ⌨. */
.fjk-suggest {
  flex: 0 0 36px; height: 36px; min-height: 0; display: flex; align-items: stretch; gap: 6px;
  border-bottom: 1px solid #33363b;
}
.fjk-sugg-list { flex: 1 1 0; min-width: 0; display: flex; align-items: stretch; overflow: hidden; }
.fjk-sugg {
  flex: 1 1 0; min-width: 64px; max-width: 240px; display: flex; align-items: center; justify-content: center;
  padding: 0 8px; border-radius: 6px; font-size: 21px; color: var(--text); white-space: nowrap; overflow: hidden;
}
.fjk-sugg + .fjk-sugg { box-shadow: -1px 0 0 #33363b; }
.fjk-sugg.fjk-sugg-typed { color: var(--dim); font-style: italic; }
.fjk-sugg.fjk-sugg-correction { color: #c9d7f2; }
.fjk-sugg.fjk-pressed { background: var(--pressed); }
.fjk-sugg.fjk-sugg-comp {
  flex: 0 0 auto; max-width: 45%; justify-content: flex-start; padding: 0 14px; font-size: 22px;
  background: #202124; border-radius: 6px; box-shadow: none;
}
.fjk-sugg.fjk-sugg-comp + .fjk-sugg-list { border-left: 1px solid #33363b; }
.fjk-page { flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.fjk-row { flex: 1 1 0; display: flex; gap: 3px; min-height: 0; }
.fjk-spacer { flex: 1 1 0; }
.fjk-key {
  position: relative; flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; background: var(--key); border: 1px solid var(--key-edge);
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.45);
  font-size: 32px; line-height: 1; cursor: pointer; color: var(--text);
  transition: background-color 60ms linear;
}
.fjk-key.fjk-side { background: var(--side); border-color: var(--side-edge); font-size: 22px; color: #dde1e5; }
.fjk-key.fjk-pressed { background: var(--pressed); box-shadow: none; transform: translateY(1px); }
.fjk-key.fjk-long { background: var(--accent); color: var(--accent-text); }
.fjk-key.fjk-accent { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 700; }
.fjk-key.fjk-accent.fjk-pressed { background: #aecbfa; }
.fjk-key.fjk-on { border-color: var(--accent); color: var(--accent); }
.fjk-key.fjk-lock { background: #394457; }
/* An armed one-shot Ctrl / Alt is filled, so it is hard to miss before the next key. */
.fjk-key.fjk-on[data-fjk-id="ctrl"], .fjk-key.fjk-on[data-fjk-id="alt"] { background: #394457; }
.fjk-page-kana .fjk-key[data-fjk-id="punct"], .fjk-page-kana .fjk-key[data-fjk-id="modify"] { font-size: 22px; }
.fjk-page-kana .fjk-key[data-fjk-id="space"], .fjk-page-kana .fjk-key[data-fjk-id="enter"] { font-size: 20px; }
.fjk-char { font-size: 28px; }
.fjk-key.fjk-symbol { font-size: 26px; }
.fjk-page-qwerty .fjk-key[data-fjk-id="space"], .fjk-page-num .fjk-key[data-fjk-id="space"],
.fjk-page-num2 .fjk-key[data-fjk-id="space"] { font-size: 18px; color: var(--dim); }
.fjk-page-sym1 .fjk-key[data-fjk-id="space"], .fjk-page-sym2 .fjk-key[data-fjk-id="space"] { font-size: 20px; }
.fjk-root.fjk-composing .fjk-key[data-fjk-id="space"] { color: var(--text); font-size: 20px; }
.fjk-icon {
  width: 30px; height: 30px; display: block; fill: none; stroke: currentColor;
  stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
}
.fjk-page-qwerty .fjk-icon, .fjk-page-num .fjk-icon, .fjk-page-num2 .fjk-icon,
.fjk-page-sym1 .fjk-icon, .fjk-page-sym2 .fjk-icon { width: 26px; height: 26px; }
.fjk-up { position: absolute; top: 3px; right: 6px; font-size: 13px; color: var(--dim); }
.fjk-m-kana, .fjk-m-en { color: var(--dim); font-size: 17px; }
.fjk-key[data-mode="kana"] .fjk-m-kana, .fjk-key[data-mode="qwerty"] .fjk-m-en { color: var(--text); font-size: 23px; font-weight: 700; }

/* Flick guide. */
.fjk-guide { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.fjk-cell {
  position: absolute; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; background: #4a4e55; color: #fff; font-size: 30px;
  border: 1px solid #6b7078; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.6);
}
.fjk-cell.fjk-empty { opacity: 0.35; }
.fjk-cell.fjk-active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); transform: scale(1.08); }

/* Kana page: bar under the candidates with the close button (left), the update indicator and
   "Steam ⌨" (right). */
.fjk-kbar {
  flex: 0 0 36px; height: 36px; min-height: 0; display: flex; align-items: center; gap: 6px;
  padding-top: 3px; border-top: 1px solid #33363b;
}
.fjk-kbar-space { flex: 1 1 0; }
/* Panel buttons, identical in the kana bar and the English strip (.fjk-btnrow): 32 px tall
   targets, easier to hit with a VR laser. */
.fjk-btnrow .fjk-close { flex: 0 0 52px; width: 52px; height: 32px; align-self: center; }
.fjk-btnrow .fjk-stock {
  flex: 0 0 auto; margin-left: 0; height: 32px; align-self: center; display: flex; align-items: center;
  padding: 0 14px; border-radius: 8px; background: var(--side); color: #c7ccd3; font-size: 14px;
}

/* Update indicator: a dot inside a 52 px button, in the kana bar and in the English strip; see
   ui.js's renderUpdate. Hidden while something is being typed (update.js's isIndicatorShown). */
.fjk-update { display: flex; align-items: center; justify-content: center; cursor: pointer; }
.fjk-update-dot {
  width: 14px; height: 14px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.14); border: 1px solid var(--side-edge);
}
.fjk-update.fjk-update-badge .fjk-update-dot { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 4px var(--accent); }
.fjk-btnrow .fjk-update {
  flex: 0 0 52px; height: 32px; align-self: center; border-radius: 8px; border: 1px solid var(--side-edge);
  background: var(--side);
}
.fjk-btnrow .fjk-update.fjk-pressed { background: var(--pressed); }
/* Cut / copy / paste in the English strip (same look as "Steam ⌨"). */
.fjk-clips { flex: 0 0 auto; display: flex; gap: 6px; align-self: center; margin-left: 10px; }
.fjk-clip {
  height: 32px; display: flex; align-items: center; padding: 0 14px; border-radius: 8px;
  border: 1px solid var(--side-edge); background: var(--side); color: #c7ccd3; font-size: 14px; cursor: pointer;
}
.fjk-clip.fjk-pressed { background: var(--pressed); color: var(--text); }
/* The kana bar is narrow (326 px inside): icon buttons, 42 px wide, and slightly smaller neighbours. */
.fjk-kbar { gap: 4px; }
.fjk-kbar .fjk-clips { margin-left: 4px; gap: 4px; }
.fjk-clip.fjk-clip-icon { width: 42px; padding: 0; justify-content: center; }
.fjk-clip-icon .fjk-icon { width: 22px; height: 22px; }
.fjk-kbar .fjk-close, .fjk-kbar .fjk-update { flex: 0 0 44px; width: 44px; }
.fjk-kbar .fjk-stock { padding: 0 9px; font-size: 13px; }
/* The banner (checking / confirm / manual / error): just above the kana bar on the kana page,
   under the strip's right end (where the indicator is) on the full-width pages. */
.fjk-update-banner {
  position: absolute; right: 6px; top: 42px; z-index: 5; max-width: 300px;
  padding: 8px 10px; border-radius: 8px; background: #202124; border: 1px solid #3a3d42;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55); font-size: 13px; line-height: 1.35; color: var(--text);
}
.fjk-split .fjk-update-banner { right: auto; top: auto; left: 10px; bottom: 48px; }
.fjk-update-detail { margin-top: 4px; color: var(--dim); font-size: 11px; }
.fjk-update-actions { display: flex; gap: 6px; margin-top: 6px; }
.fjk-update-btn {
  flex: 1 1 0; text-align: center; padding: 5px 0; border-radius: 6px; font-size: 12px;
  background: var(--key); border: 1px solid var(--key-edge); color: var(--text); cursor: pointer;
}
.fjk-update-btn.fjk-update-yes { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 700; }

.fjk-reenable {
  position: absolute; right: 2px; top: 2px; width: 44px; height: 26px; border-radius: 13px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(138, 180, 248, 0.9); color: #0b1b33; font-size: 15px; font-weight: 700; cursor: pointer;
  font-family: "Noto Sans CJK JP", "Noto Sans JP", sans-serif; touch-action: none;
}
`;
