# @matheusbbarni/pi-stitch-mcp

Pi extension that exposes Google Stitch MCP tools inside Pi.

## install

```bash
pi install npm:@matheusbbarni/pi-stitch-mcp
```

## configuration

Set the API key through your shell environment before starting Pi:

```bash
export STITCH_MCP_API_KEY="..."
```

Optional environment variables:

- `STITCH_MCP_URL` — defaults to `https://stitch.googleapis.com/mcp`
- `GOOGLE_API_KEY` — fallback if `STITCH_MCP_API_KEY` is not set

The extension also supports a local `config.json` next to `index.ts` for local development, but `config.json` and `.env*` are ignored by git and npm packaging. Do not commit secrets.

## usage

After Pi loads the package, run:

```text
/stitch-mcp
/stitch-mcp refresh
/stitch-mcp reconnect
```

The bridge registers `stitch_mcp_status`, resource/prompt helpers, and any tools discovered from the Stitch MCP server using the `stitch_` prefix.
