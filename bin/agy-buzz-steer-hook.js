#!/usr/bin/env node
import { runSteeringHook } from '../src/steering.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try { input = JSON.parse(raw || '{}'); }
catch { input = null; }

const result = input === null ? {} : await runSteeringHook({ input, env: process.env });
process.stdout.write(`${JSON.stringify(result)}\n`);
