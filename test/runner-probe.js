import { runnerMode } from '../src/runner.js';
console.log(JSON.stringify({ mode: runnerMode(), command: process.env.npm_command, event: process.env.npm_lifecycle_event }));
