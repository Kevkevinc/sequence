import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getRequiredEnv } from '@/lib/env';
import * as schema from './schema';

// `prepare: false` is required because DATABASE_URL points at Supabase's
// PgBouncer pooler in transaction mode (port 6543). Server-side prepared
// statements are unsafe there: PgBouncer can route a prepare and its later
// execute to different backend connections, which causes intermittent wrong
// query results under concurrent load (see postgres.js docs on PgBouncer).
const queryClient = postgres(getRequiredEnv('DATABASE_URL'), { prepare: false });
export const db = drizzle(queryClient, { schema });
