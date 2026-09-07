#!/usr/bin/env node
import { runDoctorCli } from '../src/doctor.js';

process.exitCode = await runDoctorCli();
