# Tiny Wars — Friends Edition

Turn-based 2D artillery for two players over the internet (Worms-style), with
private rooms, mobile-first controls, and a fully authoritative server.

## Run locally

```bash
npm install
npm start          # http://localhost:8787
```

Open the page in two browsers (or two tabs), click **Create Room** in one,
enter the 5-letter code in the other (or open `/?code=XXXXX`). Landscape is
recommended on phones.

## Tests

```bash
npm test           # node --test: rules, physics, terrain, server validation
```

## Controls

| Action | Touch | Keyboard |
|---|---|---|
| Move | ◀ ▶ buttons | A/D or ←/→ |
| Jump | ⤒ button | W / F |
| Aim | drag on the map, or ▲/▼ | ↑/↓ |
| Power | vertical slider | Q/R |
| Weapon | weapon row | 1–5 |
| Fire | 🔥 FIRE | Space |
| End turn | END TURN | E |

## Architecture

- `shared/game.js` — all rules & physics (terrain gen, ballistic sim, weapons,
  turns, win detection). Runs **only on the server**.
- `server.js` — HTTP static + WebSocket rooms. Authoritative: validates player
  identity (reconnect tokens), legal turns, movement, weapons, duplicates.
  Simulates at 30 Hz, broadcasts snapshots + events (craters, booms, damage).
- `public/client.js` — renders snapshots, sends intents. Never simulates.
  Reconnects with stored room token and receives full state (incl. terrain).
- `public/index.html` — HUD, mobile controls, menu, victory screen.

### Sync model

Server-authored: clients send *intents* (`input`, `aim`, `fire`, `endturn`),
server validates them against turn state, steps physics, and broadcasts
`state` (30 Hz) plus discrete `event`s (crater deltas are authoritative).
Clients mirror terrain from the full snapshot at start and patch it with
`crater` events.

### Server validation

- Team/phase checks on every action (`not_your_turn`, `bad_weapon`, `bad_angle`…)
- Duplicate-action guard (same payload within 80–500 ms is a retransmit)
- Reconnect requires the 16-byte token issued at join (forged tokens rejected)
- Disconnect > 90 s = forfeit for the absent player; rooms reaped after 30 min
