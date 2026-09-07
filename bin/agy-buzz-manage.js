#!/usr/bin/env node

import { runManageCli } from '../src/manage.js';

process.exitCode = await runManageCli();
