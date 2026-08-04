# @pipeworx/owid

Our World in Data MCP — curated indicators + raw chart data, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `list_popular_indicators(category?)` — curated catalog of high-signal slugs.
- `fetch_indicator(slug, country?, since_year?, until_year?, limit?)` — tidy long-format data for one indicator.
- `get_indicator_metadata(slug)` — title, units, source, last updated.

## Data source

`https://ourworldindata.org/grapher/<slug>.csv` and `.metadata.json` — public, no key required.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "owid": {
      "url": "https://gateway.pipeworx.io/owid/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Owid data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
