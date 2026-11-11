# Feedback — fix/ui-v2-walkthrough-polish

Checklist (ticked as each lands):
- [x] C1 the sound button mutes ALL sound (v1 and v2), one flag in `src/lib/sounds.ts`
- [ ] C2 landing: every section boundary uses the same narrative motion
- [ ] C3 no em dash in visitor-facing copy (v1 and v2) + guard test
- [ ] Verify block and compare link

## 1. Mute
- Engine: `soundEnabled` (default true) replaces `bgMusicEnabled`. Off: all 10 Web Audio `play*`, `playMP3` (touch, confirm, cancel), `startWaitingSound`, `startBackgroundMusic` return before creating any `Audio`/`AudioContext` node; `toggleBackgroundMusic()` stops music and the waiting loop. Nobody's call site changed.
- Both buttons say `Mute sound` / `Unmute sound` (title and aria-label). v1 button got `data-v1-sound-toggle`; the v2 hide rule in `shell.css` used the old label suffix, so it now keys on that attribute.
- Tests: `src/lib/sounds.mute.test.tsx` (table over every export, completeness check, loop stop, back-on, both buttons).
