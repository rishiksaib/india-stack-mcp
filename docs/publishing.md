# Publishing Checklist

Everything needed to go from this repo to discoverable-by-buyers.

## 1. GitHub

```bash
git remote add origin git@github.com:<you>/india-stack-mcp.git
git push -u origin main
```

- Add repo topics: `mcp`, `model-context-protocol`, `tally`, `zoho`, `gst`, `fintech`, `ai-agents`, `india`
- Description: "Production-grade MCP servers for Indian enterprise systems - Tally, Zoho Books, GST. Agents that can do books and file taxes in India."
- Pin the repo; enable Issues + Discussions.

## 2. npm (scoped public packages)

```bash
npm login
npm publish --access public -w @india-stack/core
npm publish --access public -w @india-stack/connector-tally
npm publish --access public -w @india-stack/connector-zoho
npm publish --access public -w @india-stack/connector-gst
```

Before first publish, set `"repository"` / `"homepage"` fields in each package.json to the
GitHub URL (registries rank linked packages higher). Keep `demo-host` private.

## 3. MCP registries and directories (in order of traffic)

1. **Smithery** - submit via smithery.ai; it indexes from GitHub/npm, then request listing.
2. **Glama** - glama.ai/mcp/servers - auto-crawls npm; claim the entries.
3. **PulseMCP** - pulsemcp.com - submit server listings manually (fast approval).
4. **Anthropic connector directory** - once traction exists, apply via the Claude Directory form.
5. **MCP.so** and similar aggregators - low effort, do them all.

Listing copy that works: lead with "Tally MCP" / "Zoho Books MCP" / "GST MCP" keywords -
buyers search by system name, not by "India Stack".

## 4. Launch posts (same day as registry submissions)

- X/Twitter thread with a 30s demo video: Claude creating a balanced Sales voucher in Tally via dry-run preview, then reconciling GSTR-2B.
- r/IndiaInvestments? No - better: r/developersIndia, IndiaSaaS communities, Tally developer forums, Zoho communities.
- Show HN only after stars exist; cold HN launches of dev tools without demo assets underperform.

## 5. Buyer-facing artifacts (the acquisition funnel)

- One-page PDF: architecture diagram + security model (dry-run defaults, hash-chained audit log, idempotent writes) + eval results.
- The `evals/` suite doubles as your certification story: "every connector ships with golden-task benchmarks."
- Outbound shortlist: Sarvam (Indus compatibility - they hand-build Finacle/SAP skills), Composio and Nango (catalog gaps), ClearTax/Zoho (strategic), global labs seeking an India wedge.

## 6. Hygiene before any buyer conversation

- SOC 2-lite posture documented (audit trail design, credential vault, no data egress by default).
- Real Tally + Zoho org screenshots/video for the live-demo story (`TALLY_LIVE=1` / `ZOHO_LIVE=1`).
- Versioned releases on GitHub with changelogs.
