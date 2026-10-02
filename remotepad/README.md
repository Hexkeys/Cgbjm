# RemotePad

Control your own Windows PC from any browser, DWService-style. The web app shows
your live screen and has a **touchpad** and a **clickable on-screen keyboard**,
so it works well from a phone or tablet.

```
Browser (touchpad + keyboard)  <--wss-->  Render server  <--wss-->  RemotePad-Agent.exe (your PC)
```

The PC agent connects **outbound** to the server, so no port forwarding is needed.

## Repo layout

| Path | What it is |
|---|---|
| `server/` | Node web app + WebSocket relay (deploy this to Render) |
| `agent/` | Python agent for Windows (built into `RemotePad-Agent.exe`) |
| `.github/workflows/build-agent.yml` | Builds the exe on GitHub and publishes it as a Release |
| `render.yaml` | Render blueprint |

## Setup

1. **Push this repo to GitHub.** The *Build Windows agent* workflow runs automatically
   and publishes `RemotePad-Agent.exe` under **Releases > latest**
   (also available as a build artifact in the Actions tab).
2. **Deploy to Render:** New > Blueprint > pick your repo (uses `render.yaml`).
   Set `ACCESS_PASSWORD` to a long, unique password. Render generates `AGENT_TOKEN`
   for you; copy it from the service's Environment tab.
3. **On the PC:** download `RemotePad-Agent.exe`, run it, and enter your Render URL
   and the agent token. They are saved to `%APPDATA%\RemotePad\config.json`.
4. **Open your Render URL** in a browser, sign in, and tap your PC.

## Using the web app

- **Touchpad:** drag = move, tap = click, two-finger tap = right-click, two-finger drag
  or the side strip = scroll. **Left / Right** buttons can be held to drag; **Drag** toggles a drag lock.
- **Tap the screen** (the 🎯 toggle) to jump the cursor there and click.
- **Keyboard:** Shift / Ctrl / Alt / Win are one-shot: tap, then tap a key. The top row has
  shortcuts (Win, Alt+Tab, Ctrl+C/V/X/A/Z, Win+D, Win+R, Alt+F4) and F-keys.
- **Quality** (Low / Medium / High) trades sharpness for speed.

## Security

- Use a strong `ACCESS_PASSWORD` and keep `AGENT_TOKEN` secret. Anyone with the password
  controls every connected PC. Login attempts are rate-limited and sessions expire after 12 hours.
- Always use the HTTPS Render URL.
- The agent runs in a visible console window and only streams while a browser is watching.
  Only install it on computers you own or have permission to control.
- Antivirus may flag any unsigned exe that injects input; allow-list it if needed.

## Limitations

- Ctrl+Alt+Del, the lock screen and UAC prompts can't be controlled by a normal user-level
  process. Run the agent as administrator to control elevated windows.
- Primary monitor only, no audio, no clipboard sync.
- Render's free plan sleeps when idle; the agent reconnects automatically after the first
  request wakes it (it can take about a minute).

## Local test

```
cd server && npm install
ACCESS_PASSWORD=test AGENT_TOKEN=secret node server.js
pip install -r agent/requirements.txt
python agent/agent.py --server http://localhost:3000 --token secret
```
