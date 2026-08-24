#!/usr/bin/env node
import { main } from "../dist/server.js";

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
