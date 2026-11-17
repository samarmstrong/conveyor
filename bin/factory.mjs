#!/usr/bin/env node
// The `factory` command of an installed engine. The engine is TypeScript run as
// it is written, with no build between the source and what a tick executes, so
// this registers tsx (Node will not strip types under node_modules) and hands
// over to the CLI. The deployment is the directory it is run from: its
// factory.config.json, principles.md, .env and telemetry are read there
// (FACTORY_ROOT overrides).
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
