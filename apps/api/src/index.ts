import { startJobEnvMove } from '@repo/db';
import { app } from './app';
import { startBackgroundJobs } from './background';
import { listenOptions } from './listen-options';

// Bind the port. The app itself is assembled in ./app.ts (without `.listen()`)
// so tests can import it and drive routes in memory. API_HOST, when set, names the one
// address to bind; unset binds every interface as before (see ./listen-options.ts).
app.listen(listenOptions(process.env));

startJobEnvMove('api');
startBackgroundJobs();

console.log(`🦊 API running at http://${app.server?.hostname}:${app.server?.port}`);

export type { App } from './app';
