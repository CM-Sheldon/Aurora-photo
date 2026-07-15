# Aurora caption worker (standalone / offload)

Generates a natural-language description for every Aurora photo using an Ollama
vision-LLM, so you can search in plain English — e.g. **“girl holding a coffee”**,
**“dog on a beach”** — and combine it with places, dates, tags and content chips.

> **You probably don't need this script.** Aurora now has a built-in captioning
> service you start/stop from **Settings → Manage → Photo descriptions**, with model/
> server config and a live log. Use it for the normal case. This standalone worker is
> only for **offloading** the orchestration to another machine (e.g. to run many
> parallel requests from a beefier box) — it talks to the same HTTP endpoints.

All the ML happens on the Ollama server either way; the Aurora box only stores and
searches the resulting text (it's a low-power N100 with 2 GB RAM and must stay light).

## How it works

1. The worker asks Aurora for un-captioned photos: `GET /api/aurora/captions/pending`.
2. For each, it downloads a light 2048px JPEG preview (the URL is supplied by the
   `pending` response — `/api/aurora/captions/image/<id>`; JPEG because vision models
   reject webp), sends it to Ollama (`/api/generate`) with a description prompt, and
   posts the caption back: `POST /api/aurora/captions/ingest`.
3. Aurora stores the caption and makes it keyword-searchable (it plugs into the same
   search box, chips, `strict` mode and fuzzy correction as everything else).

It is **stateless and resumable** — the “which photos still need captioning” cursor
lives on the server, so you can stop/restart this any time. A photo is only marked
done once its caption is stored; if Ollama errors on one, it's just retried next pass.

## Setup

1. Install [Ollama](https://ollama.com) on the Mac (or point `OLLAMA` at the box that
   runs it).
2. Pull a vision model. Lighter = less RAM:
   ```sh
   ollama pull qwen2.5vl:3b     # default — light, good quality
   ollama pull moondream        # lightest/fastest, lower quality
   ollama pull qwen2.5vl:7b     # higher quality, more RAM
   ```
3. Run the worker (Node 18+):
   ```sh
   node caption-worker.js
   ```

## Configuration (environment variables)

| Var          | Default                      | Meaning |
|--------------|------------------------------|---------|
| `AURORA`     | `http://localhost:8080`      | Aurora server base URL |
| `OLLAMA`     | `http://localhost:11434`     | Ollama base URL |
| `MODEL`      | `qwen2.5vl:3b`               | Ollama vision model |
| `BATCH`      | `20`                         | Photos fetched per request |
| `CONCURRENCY`| `1`                          | Simultaneous Ollama calls (raise if Ollama keeps up) |
| `IDLE_MS`    | `60000`                      | Sleep when nothing is pending |
| `TIMEOUT_MS` | `120000`                     | Per-photo Ollama timeout |

Example:
```sh
AURORA=http://aurora.local:8080 OLLAMA=http://ollama.local:11434 \
  MODEL=qwen2.5vl:3b BATCH=20 CONCURRENCY=2 node caption-worker.js
```

## Monitoring

Watch progress in Aurora → **Settings → Manage → Photo descriptions** (a progress bar
that fills as captions arrive), or poll `GET /api/aurora/captions/status` →
`{ "captioned": N, "total": M }`.

## Notes

- Throughput is roughly 1–5 s/photo on an M-series Mac, so a large library captions
  over a day or two, fully in the background. Bump `CONCURRENCY` if Ollama has headroom.
- The raw caption text is stored verbatim on the server, so a future upgrade can embed
  it for semantic vector search without re-captioning anything.
- Run it as a background service (e.g. a `launchd` plist or `tmux`/`screen`) so it keeps
  going after you close the terminal.
